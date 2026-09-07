import { and, asc, eq, inArray, ne } from "drizzle-orm";
import {
  groceryLine,
  groceryList,
  groceryListVersion,
  planEntry,
  planVersion,
} from "@/db/schema";
import { firstRow } from "@/db/rows";
import { normalizeTerm } from "@/domain/allergens";
import { DomainError } from "@/domain/errors";
import {
  cycleFromStart,
  dateOfEntry,
  formatCycleStart,
  isoWeeksInCycle,
  isWithinCycle,
  parseCycleStart,
  type ShoppingCycle,
} from "@/domain/shopping";
import {
  aggregateGroceryLines,
  compareLines,
  scaleQuantity,
  type AggregatedGroceryLine,
  type GrocerySourceLine,
} from "@/domain/grocery";
import { manualLineInputSchema } from "@/domain/schemas";
import { totalServingsFor } from "@/domain/prep";
import type { GroceryLineOrigin, GroceryListState } from "@/domain/vocabulary";
import type { IsoWeek } from "@/domain/week";
import { inScope, type ScopedContext, type ServiceContext } from "./context";
import { loadPantryCoverage, type PantryCoverage } from "./pantry-service";
import { findActivePlanVersion } from "./plan-queries";
import { loadPrepLinks } from "./prep-service";
import { loadRecipeBaskets, numberOrNull } from "./recipe-service";

/**
 * The grocery list: generated from a plan version, then persisted and edited in
 * place.
 *
 * Regeneration merges rather than wipes. That is the whole difficulty of this
 * feature and the reason it is worth writing down: the user is standing in a
 * shop with half the list ticked off when the plan changes, and a regeneration
 * that resets their progress is worse than no regeneration at all. So checked
 * state survives, manual lines survive, and the caller is told exactly what
 * moved so the screen can highlight it.
 *
 * Pantry subtraction marks lines rather than deleting them: a staple you have
 * is shown in a collapsed "you should already have" section, because the one
 * week you are out of flour is the week a silently missing line ruins dinner.
 */

export interface GroceryLineView {
  readonly id: string;
  readonly ingredientId: string | null;
  readonly displayName: string;
  readonly quantity: number | null;
  readonly unit: string | null;
  readonly aisle: string | null;
  readonly origin: GroceryLineOrigin;
  readonly checked: boolean;
  readonly coveredByPantry: boolean;
  /** Something to eat before it goes. Marked, never removed. */
  readonly useSoon: boolean;
  /** Optional in every recipe that asked for it: shopped from its own section. */
  readonly optional: boolean;
  readonly unmergeableGroup: string | null;
  readonly sourceEntryIds: string[];
}

export interface GroceryEntrySource {
  readonly entryId: string;
  readonly dayOfWeek: number;
  readonly title: string;
  /**
   * Null when the recipe behind the entry is gone. Carried so the shopping
   * screen can mark a line with the same colour the dish wears in the week,
   * which is derived from the recipe id and nothing else.
   */
  readonly recipeId: string | null;
}

export interface GroceryListView {
  readonly id: string;
  readonly state: GroceryListState;
  /** First and last day covered, as `yyyy-mm-dd`. */
  readonly startsOn: string;
  readonly endsOn: string;
  /** True when any version the list was built from is no longer active. */
  readonly stale: boolean;
  readonly generatedAt: Date;
  readonly updatedAt: Date;
  readonly lines: GroceryLineView[];
  /** Which meal each source entry is, so a line can explain itself. */
  readonly sources: GroceryEntrySource[];
}

export interface GroceryDiff {
  readonly added: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly removed: number;
  /**
   * Added and updated lines, for the screen to highlight. Deliberately not
   * persisted: a highlight is about the last regeneration, not about the line.
   */
  readonly changedLineIds: string[];
}

export interface GenerateResult {
  readonly list: GroceryListView;
  readonly diff: GroceryDiff;
}

export async function getGroceryList(
  ctx: ServiceContext,
  cycleStart: unknown,
): Promise<GroceryListView | null> {
  const cycle = requireCycle(cycleStart);

  return inScope(ctx, async (scoped) => {
    const found = await findLiveList(scoped, cycle);
    if (!found) return null;
    return loadListView(scoped, found.listId);
  });
}

/**
 * Generates the list for a shopping cycle, or merges into the one already
 * there. Runs against the active version of every ISO week the cycle overlaps,
 * because that is the plan the user is actually going to cook.
 */
export async function generateGroceryList(
  ctx: ServiceContext,
  cycleStart: unknown,
): Promise<GenerateResult> {
  const cycle = requireCycle(cycleStart);

  return inScope(ctx, async (scoped) => {
    const { tx } = scoped;
    const versions = await versionsForCycle(scoped, cycle);
    if (versions.length === 0) {
      throw new DomainError(
        "NOT_FOUND",
        `Aucune semaine planifiée entre le ${formatCycleStart(cycle.startsOn)} et le ${formatCycleStart(cycle.endsOn)}. Planifiez au moins un repas avant de générer une liste de courses.`,
        {
          startsOn: formatCycleStart(cycle.startsOn),
          endsOn: formatCycleStart(cycle.endsOn),
        },
      );
    }

    const aggregated = await aggregateForCycle(scoped, cycle, versions);
    const coverage = await loadPantryCoverage(scoped);

    const listId = await ensureListForCycle(scoped, cycle);

    if (listId.created) {
      await recordVersions(scoped, listId.id, versions);
      const inserted = await insertDerivedLines(
        scoped,
        listId.id,
        aggregated,
        coverage,
      );

      return {
        list: await loadListView(scoped, listId.id),
        diff: {
          added: inserted.length,
          updated: 0,
          unchanged: 0,
          removed: 0,
          changedLineIds: inserted,
        },
      };
    }

    const diff = await mergeIntoList(scoped, listId.id, aggregated, coverage);
    await recordVersions(scoped, listId.id, versions);
    // `updatedAt` carries `$onUpdate`, so the touch only has to be an update.
    await tx
      .update(groceryList)
      .set({ state: "active" })
      .where(
        and(eq(groceryList.id, listId.id), eq(groceryList.userId, ctx.userId)),
      );

    return { list: await loadListView(scoped, listId.id), diff };
  });
}

/**
 * The live list for this cycle, created if there is none.
 *
 * Find-then-insert is a race against `grocery_list_one_live_per_cycle_idx`: two
 * regenerations of the same cycle arriving together both found nothing and both
 * inserted, and the loser got a raw `23505` rather than merging into the list
 * the winner had just created. The insert is now conditional and a conflict is
 * resolved by re-reading, which is the same shape `ensurePlan` and `getProfile`
 * use.
 */
async function ensureListForCycle(
  ctx: ScopedContext,
  cycle: ShoppingCycle,
): Promise<{ id: string; created: boolean }> {
  const existing = await findLiveList(ctx, cycle);
  if (existing) return { id: existing.listId, created: false };

  const created = await ctx.tx
    .insert(groceryList)
    .values({
      userId: ctx.userId,
      startsOn: formatCycleStart(cycle.startsOn),
      endsOn: formatCycleStart(cycle.endsOn),
      state: "active",
    })
    .onConflictDoNothing()
    .returning({ id: groceryList.id });

  const [row] = created;
  if (row) return { id: row.id, created: true };

  const reread = await findLiveList(ctx, cycle);
  if (!reread) {
    throw new DomainError(
      "VALIDATION",
      `La liste de courses du cycle du ${formatCycleStart(cycle.startsOn)} n'a pas pu être créée.`,
      { startsOn: formatCycleStart(cycle.startsOn) },
    );
  }
  return { id: reread.listId, created: false };
}

/**
 * Cycles arrive as `2026-09-05` from a URL or an action. Rejected loudly rather
 * than coerced: a rolled-over date would silently shop for the wrong week.
 */
function requireCycle(value: unknown): ShoppingCycle {
  const raw = typeof value === "string" ? value : "";
  const start = parseCycleStart(raw);
  if (!start) {
    throw new DomainError(
      "VALIDATION",
      `Cycle de courses invalide : ${raw}. Attendu une date de début au format 2026-09-05.`,
      { cycleStart: raw },
    );
  }
  return cycleFromStart(start);
}

export async function setLineChecked(
  ctx: ServiceContext,
  lineId: string,
  checked: boolean,
): Promise<void> {
  await inScope(ctx, async ({ tx }) => {
    const rows = await tx
      .update(groceryLine)
      .set({ checked })
      .where(
        and(eq(groceryLine.id, lineId), eq(groceryLine.userId, ctx.userId)),
      )
      .returning({ id: groceryLine.id });
    if (!rows[0]) {
      throw new DomainError("NOT_FOUND", "Cette ligne n'existe pas.", {
        lineId,
      });
    }
  });
}

/**
 * Coffee, dish soap, the things no recipe knows about. Manual lines are never
 * touched by a regeneration.
 *
 * `manualLineInputSchema` validates rather than an interface plus one length
 * check. The old shape looked at `displayName` and nothing else, so a negative
 * quantity, a twenty-thousand-character unit and an arbitrary aisle all went
 * straight into the row.
 */
export async function addManualLine(
  ctx: ServiceContext,
  listId: string,
  input: unknown,
): Promise<GroceryLineView> {
  const parsed = manualLineInputSchema.parse(input);

  return inScope(ctx, async (scoped) => {
    await requireList(scoped, listId);
    const rows = await scoped.tx
      .insert(groceryLine)
      .values({
        userId: ctx.userId,
        groceryListId: listId,
        displayName: parsed.displayName,
        quantity: parsed.quantity === null ? null : String(parsed.quantity),
        unit: parsed.unit,
        aisle: parsed.aisle,
        origin: "manual",
      })
      .returning();
    return toLineView(
      firstRow(rows, "manual grocery line insert"),
      await loadPantryCoverage(scoped),
    );
  });
}

export async function deleteLine(
  ctx: ServiceContext,
  lineId: string,
): Promise<void> {
  await inScope(ctx, async ({ tx }) => {
    const rows = await tx
      .delete(groceryLine)
      .where(
        and(eq(groceryLine.id, lineId), eq(groceryLine.userId, ctx.userId)),
      )
      .returning({ id: groceryLine.id });
    if (!rows[0]) {
      throw new DomainError("NOT_FOUND", "Cette ligne n'existe pas.", {
        lineId,
      });
    }
  });
}

export async function archiveGroceryList(
  ctx: ServiceContext,
  listId: string,
): Promise<void> {
  await inScope(ctx, async ({ tx }) => {
    const rows = await tx
      .update(groceryList)
      .set({ state: "archived" })
      .where(
        and(
          eq(groceryList.id, listId),
          eq(groceryList.userId, ctx.userId),
          ne(groceryList.state, "archived"),
        ),
      )
      .returning({ id: groceryList.id });
    if (!rows[0]) {
      throw new DomainError(
        "NOT_FOUND",
        "Cette liste de courses n'existe pas ou est déjà archivée.",
        { listId },
      );
    }
  });
}

interface CycleVersion {
  readonly id: string;
  readonly versionNumber: number;
  readonly week: IsoWeek;
}

/**
 * The active version of every ISO week the cycle touches. A seven-day cycle
 * touches one week or two; a week with no active plan simply contributes
 * nothing, which is how a half-planned cycle still produces a usable list.
 */
async function versionsForCycle(
  ctx: ScopedContext,
  cycle: ShoppingCycle,
): Promise<CycleVersion[]> {
  const found: CycleVersion[] = [];
  for (const week of isoWeeksInCycle(cycle)) {
    // `findActivePlanVersion` lives in plan-queries. This file used to carry
    // its own join for it, which was `findPlan` plus `findVersion` written out.
    const active = await findActivePlanVersion(ctx, week);
    if (active) found.push({ ...active, week });
  }
  return found;
}

/** Rewritten on every regeneration, so staleness always reflects the last build. */
async function recordVersions(
  ctx: ScopedContext,
  listId: string,
  versions: readonly CycleVersion[],
): Promise<void> {
  await ctx.tx
    .delete(groceryListVersion)
    .where(
      and(
        eq(groceryListVersion.userId, ctx.userId),
        eq(groceryListVersion.groceryListId, listId),
      ),
    );

  if (versions.length === 0) return;
  await ctx.tx.insert(groceryListVersion).values(
    versions.map((version) => ({
      userId: ctx.userId,
      groceryListId: listId,
      planVersionId: version.id,
    })),
  );
}

/**
 * What to buy for one shopping cycle.
 *
 * Reads the cycle's entries, scales every recipe to the servings the entry asks
 * for, and aggregates. Soft-deleted recipes still contribute: the meal is still
 * planned, and the shopper still needs the ingredients. (This docstring used to
 * sit on the `CycleVersion` interface above, which is a three-field record and
 * does none of it.)
 *
 * The rule is about cooking sessions, not about meals. You buy for a session
 * that happens inside the cycle, scaled to cover everything it feeds, including
 * a meal that will be eaten after the next shop: the cooking is now, so the
 * ingredients are needed now. A meal fed by a session outside the cycle costs
 * nothing here, because it was bought with that session on an earlier shop.
 *
 * That is what makes a mid-week shop work. Meals already cooked earlier in the
 * cycle fall outside it and drop off the list instead of sitting there unticked.
 */
async function aggregateForCycle(
  ctx: ScopedContext,
  cycle: ShoppingCycle,
  versions: readonly CycleVersion[],
): Promise<AggregatedGroceryLine[]> {
  if (versions.length === 0) return [];

  const entries = await ctx.tx
    .select({
      id: planEntry.id,
      recipeId: planEntry.recipeId,
      servings: planEntry.servings,
      dayOfWeek: planEntry.dayOfWeek,
      planVersionId: planEntry.planVersionId,
    })
    .from(planEntry)
    .where(
      and(
        eq(planEntry.userId, ctx.userId),
        inArray(
          planEntry.planVersionId,
          versions.map((version) => version.id),
        ),
      ),
    );

  const weekOfVersion = new Map(
    versions.map((version) => [version.id, version.week]),
  );
  const inCycle = new Set(
    entries
      .filter((entry) => {
        const week = weekOfVersion.get(entry.planVersionId);
        if (!week) return false;
        return isWithinCycle(cycle, dateOfEntry(week, entry.dayOfWeek));
      })
      .map((entry) => entry.id),
  );

  const recipeIds = [
    ...new Set(
      entries
        .map((entry) => entry.recipeId)
        .filter((id): id is string => id !== null),
    ),
  ];
  const baskets = await loadRecipeBaskets(ctx, recipeIds);

  // Batch cooking: a meal served by another entry's session was bought once,
  // with that session. Its own ingredients must not be counted a second time,
  // and the source is scaled to cover everything drawn from it.
  const links = await loadPrepLinks(
    ctx,
    entries.map((entry) => entry.id),
  );
  const dependentEntryIds = new Set(
    links
      .filter((link) => link.sourceEntryId !== null)
      .map((link) => link.dependentEntryId),
  );
  const drawsBySource = new Map<string, Array<{ servingsDrawn: number }>>();
  for (const link of links) {
    if (!link.sourceEntryId) continue;
    const draws = drawsBySource.get(link.sourceEntryId) ?? [];
    draws.push({ servingsDrawn: link.servingsDrawn });
    drawsBySource.set(link.sourceEntryId, draws);
  }

  const sourceLines: GrocerySourceLine[] = [];
  for (const entry of entries) {
    if (entry.recipeId === null) continue;
    // Fed by another session: bought with it, whenever that was.
    if (dependentEntryIds.has(entry.id)) continue;
    // Cooked in another cycle: bought on that cycle's shop.
    if (!inCycle.has(entry.id)) continue;

    const basket = baskets.get(entry.recipeId);
    if (!basket) continue;

    // `totalServingsFor` from src/domain/prep.ts, which is where the model
    // "the source's servings are its own meal, and the draws are added on top"
    // is decided. This file reimplemented the same sum.
    const servings = totalServingsFor(
      { servings: entry.servings },
      drawsBySource.get(entry.id) ?? [],
    );

    for (const line of basket.lines) {
      sourceLines.push({
        entryId: entry.id,
        ingredientId: line.ingredientId,
        rawName: line.rawName,
        canonicalName: line.canonicalName,
        aisle: line.aisle,
        quantity: scaleQuantity(line.quantity, basket.servings, servings),
        unit: line.unit,
        optional: line.optional,
        densityGPerMl: line.densityGPerMl,
      });
    }
  }

  return aggregateGroceryLines(sourceLines);
}

/**
 * The merge. A derived line that still exists keeps its checked state and takes
 * the new quantity; one that no longer has a source is dropped; a new one
 * arrives unchecked. Manual lines are not considered at all.
 *
 * The writes are batched. This used to issue one INSERT or one UPDATE per
 * aggregated line, and it updated every surviving line whether or not anything
 * about it had changed, so regenerating an unchanged forty-line list was forty
 * pointless UPDATEs inside the transaction. New lines go in one insert, and a
 * surviving line is only written when one of its stored fields actually
 * differs.
 */
async function mergeIntoList(
  ctx: ScopedContext,
  listId: string,
  aggregated: readonly AggregatedGroceryLine[],
  coverage: PantryCoverage,
): Promise<GroceryDiff> {
  const { tx } = ctx;

  const current = await tx
    .select()
    .from(groceryLine)
    .where(
      and(
        eq(groceryLine.userId, ctx.userId),
        eq(groceryLine.groceryListId, listId),
        eq(groceryLine.origin, "derived"),
      ),
    );

  const byKey = new Map(current.map((row) => [matchKeyOfRow(row), row]));
  const changedLineIds: string[] = [];
  let updated = 0;
  let unchanged = 0;

  const toInsert: AggregatedGroceryLine[] = [];
  const seen = new Set<string>();

  for (const line of aggregated) {
    const key = matchKey(
      line.ingredientId,
      line.displayName,
      line.unit,
      line.optional,
    );
    seen.add(key);
    const existing = byKey.get(key);

    if (!existing) {
      toInsert.push(line);
      continue;
    }

    const next = {
      quantity: line.quantity === null ? null : String(line.quantity),
      unit: line.unit,
      aisle: line.aisle,
      sourceEntryIds: line.sourceEntryIds,
      // Re-evaluated on every regeneration: a staple added since last time
      // should drop off the list now, not next week.
      coveredByPantry: matchesCoverage(
        line,
        coverage.stapleIngredientIds,
        coverage.stapleNames,
      ),
      unmergeableGroup: line.unmergeableGroup,
    };

    const visible = shopperVisibleChange(existing, next);

    if (!needsWrite(existing, next)) {
      unchanged += 1;
      continue;
    }

    await tx
      .update(groceryLine)
      .set(next)
      .where(
        and(
          eq(groceryLine.id, existing.id),
          eq(groceryLine.userId, ctx.userId),
        ),
      );

    // Written either way, reported only when the shopping actually differs.
    if (visible) {
      updated += 1;
      changedLineIds.push(existing.id);
    } else {
      unchanged += 1;
    }
  }

  const inserted = await insertDerivedLines(ctx, listId, toInsert, coverage);
  changedLineIds.push(...inserted);

  const orphaned = current.filter((row) => !seen.has(matchKeyOfRow(row)));
  if (orphaned.length > 0) {
    await tx.delete(groceryLine).where(
      and(
        eq(groceryLine.userId, ctx.userId),
        inArray(
          groceryLine.id,
          orphaned.map((row) => row.id),
        ),
      ),
    );
  }

  return {
    added: inserted.length,
    updated,
    unchanged,
    removed: orphaned.length,
    changedLineIds,
  };
}

/**
 * Whether a stored line already says what the regeneration wants it to say.
 *
 * All five stored fields are compared, not only the quantity and the unit. The
 * old check compared those two and then wrote anyway, so the diff reported
 * "unchanged" for a line whose aisle or pantry coverage had in fact just
 * changed, and the screen highlighted nothing.
 */
interface MergedLineFields {
  quantity: string | null;
  unit: string | null;
  aisle: string | null;
  sourceEntryIds: string[];
  coveredByPantry: boolean;
  unmergeableGroup: string | null;
}

/**
 * What the shopper would notice.
 *
 * Kept apart from `needsWrite` below because the two answer different
 * questions, and conflating them made the diff lie. `diff.updated` and
 * `diff.changedLineIds` are what the screen uses to say what moved since the
 * last list, so they must mean "this line is different to buy", not "this row
 * was written".
 */
function shopperVisibleChange(
  row: typeof groceryLine.$inferSelect,
  next: MergedLineFields,
): boolean {
  return (
    numberOrNull(row.quantity) !== numberOrNull(next.quantity) ||
    row.unit !== next.unit ||
    row.aisle !== next.aisle ||
    row.coveredByPantry !== next.coveredByPantry ||
    row.unmergeableGroup !== next.unmergeableGroup
  );
}

/**
 * Whether the row has to be written at all.
 *
 * `sourceEntryIds` is provenance, not content: it is what lets the screen say
 * which meal a line came from. Plan versions are immutable, so assigning one
 * new meal writes a whole new version and every entry in the week gets a new
 * id. Every derived line's pointers therefore have to be rewritten, even the
 * ones whose quantity, unit and aisle are all identical.
 *
 * That is why it is excluded from `shopperVisibleChange`. Counting it there
 * reported every line in the week as having moved whenever any one meal
 * changed: regenerating after adding a gratin said the pepper and the onions
 * had changed too, when nothing about buying them had.
 */
function needsWrite(
  row: typeof groceryLine.$inferSelect,
  next: MergedLineFields,
): boolean {
  return (
    shopperVisibleChange(row, next) ||
    row.sourceEntryIds.length !== next.sourceEntryIds.length ||
    row.sourceEntryIds.some((id, index) => id !== next.sourceEntryIds[index])
  );
}

async function insertDerivedLines(
  ctx: ScopedContext,
  listId: string,
  lines: readonly AggregatedGroceryLine[],
  coverage: PantryCoverage,
): Promise<string[]> {
  if (lines.length === 0) return [];
  const inserted = await ctx.tx
    .insert(groceryLine)
    .values(
      lines.map((line) => derivedValues(ctx.userId, listId, line, coverage)),
    )
    .returning({ id: groceryLine.id });
  return inserted.map((row) => row.id);
}

function derivedValues(
  userId: string,
  listId: string,
  line: AggregatedGroceryLine,
  coverage: PantryCoverage,
) {
  return {
    userId,
    groceryListId: listId,
    ingredientId: line.ingredientId,
    displayName: line.displayName,
    quantity: line.quantity === null ? null : String(line.quantity),
    unit: line.unit,
    aisle: line.aisle,
    origin: "derived" as const,
    sourceEntryIds: line.sourceEntryIds,
    coveredByPantry: matchesCoverage(
      line,
      coverage.stapleIngredientIds,
      coverage.stapleNames,
    ),
    unmergeableGroup: line.unmergeableGroup,
    optional: line.optional,
    productVariant: line.productVariant,
  };
}

/**
 * Whether the pantry says something about this line, by linked ingredient or by
 * name.
 *
 * One function over two pairs of sets, because "is it a staple" and "should it
 * be used soon" were the same fifteen lines twice. Matching on the name too is
 * what makes an unlinked staple still useful.
 *
 * The ingredient half is skipped for a product variant: flour in the cupboard
 * does not cover the puff pastry that resolved to it, and a line silently
 * dropped is a dinner that does not happen.
 *
 * The name comparison is `normalizeTerm`, the same folding the allergen matcher
 * and `matchKey` below use. It was `trim().toLowerCase()` on this side only, so
 * a pantry holding "Crème fraîche" covered nothing written "creme fraiche" and
 * "Œufs" never covered "oeufs": two halves of one comparison disagreeing about
 * what the same word is.
 */
function matchesCoverage(
  line: {
    ingredientId: string | null;
    displayName: string;
    productVariant: boolean;
  },
  ingredientIds: ReadonlySet<string>,
  names: ReadonlySet<string>,
): boolean {
  if (
    line.ingredientId &&
    !line.productVariant &&
    ingredientIds.has(line.ingredientId)
  ) {
    return true;
  }
  return names.has(normalizeTerm(line.displayName));
}

/**
 * How a stored line is recognised as "the same line" on the next generation.
 * The unit is part of it because an ingredient can legitimately hold several
 * lines that could not be summed, and optionality because the required and the
 * optional half of one ingredient are two lines in two sections.
 */
function matchKey(
  ingredientId: string | null,
  displayName: string,
  unit: string | null,
  optional: boolean,
): string {
  return `${ingredientId ?? ""}|${normalizeTerm(displayName)}|${unit ?? ""}|${
    optional ? "optional" : "required"
  }`;
}

function matchKeyOfRow(row: typeof groceryLine.$inferSelect): string {
  return matchKey(row.ingredientId, row.displayName, row.unit, row.optional);
}

/**
 * The live list for a cycle, found by the date it starts on. A cycle can span
 * two ISO weeks, so there is nothing to join through: the start date is the
 * list's identity.
 */
async function findLiveList(
  ctx: ScopedContext,
  cycle: ShoppingCycle,
): Promise<{ listId: string } | null> {
  const rows = await ctx.tx
    .select({ listId: groceryList.id })
    .from(groceryList)
    .where(
      and(
        eq(groceryList.userId, ctx.userId),
        eq(groceryList.startsOn, formatCycleStart(cycle.startsOn)),
        ne(groceryList.state, "archived"),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

async function requireList(ctx: ScopedContext, listId: string): Promise<void> {
  const rows = await ctx.tx
    .select({ id: groceryList.id })
    .from(groceryList)
    .where(and(eq(groceryList.id, listId), eq(groceryList.userId, ctx.userId)))
    .limit(1);
  if (!rows[0]) {
    throw new DomainError("NOT_FOUND", "Cette liste de courses n'existe pas.", {
      listId,
    });
  }
}

async function loadListView(
  ctx: ScopedContext,
  listId: string,
): Promise<GroceryListView> {
  const { tx } = ctx;

  const lists = await tx
    .select({
      id: groceryList.id,
      state: groceryList.state,
      startsOn: groceryList.startsOn,
      endsOn: groceryList.endsOn,
      // The Drizzle property is `createdAt` now; the column is unchanged. The
      // view keeps calling it `generatedAt`, which is what the screens read and
      // the better name for the concept.
      generatedAt: groceryList.createdAt,
      updatedAt: groceryList.updatedAt,
    })
    .from(groceryList)
    .where(and(eq(groceryList.id, listId), eq(groceryList.userId, ctx.userId)))
    .limit(1);

  const list = lists[0];
  if (!list) {
    throw new DomainError("NOT_FOUND", "Cette liste de courses n'existe pas.", {
      listId,
    });
  }

  const versions = await tx
    .select({ state: planVersion.state })
    .from(groceryListVersion)
    .innerJoin(
      planVersion,
      eq(planVersion.id, groceryListVersion.planVersionId),
    )
    .where(
      and(
        eq(groceryListVersion.userId, ctx.userId),
        eq(groceryListVersion.groceryListId, listId),
      ),
    );

  const lines = await tx
    .select()
    .from(groceryLine)
    .where(
      and(
        eq(groceryLine.userId, ctx.userId),
        eq(groceryLine.groceryListId, listId),
      ),
    )
    .orderBy(asc(groceryLine.displayName));

  const coverage = await loadPantryCoverage(ctx);

  const entryIds = [...new Set(lines.flatMap((line) => line.sourceEntryIds))];
  const sources =
    entryIds.length === 0
      ? []
      : await tx
          .select({
            entryId: planEntry.id,
            dayOfWeek: planEntry.dayOfWeek,
            title: planEntry.recipeTitleSnapshot,
            recipeId: planEntry.recipeId,
          })
          .from(planEntry)
          .where(
            and(
              eq(planEntry.userId, ctx.userId),
              inArray(planEntry.id, entryIds),
            ),
          );

  return {
    id: list.id,
    state: list.state as GroceryListState,
    startsOn: list.startsOn,
    endsOn: list.endsOn,
    // A list built from a superseded version is still perfectly shoppable; the
    // screen just says so and offers to regenerate. A cycle can span two weeks,
    // so one stale contributor is enough.
    stale: versions.some((row) => row.state !== "active"),
    generatedAt: list.generatedAt,
    updatedAt: list.updatedAt,
    lines: lines.map((row) => toLineView(row, coverage)).sort(compareLines),
    sources,
  };
}

function toLineView(
  row: typeof groceryLine.$inferSelect,
  coverage: PantryCoverage,
): GroceryLineView {
  return {
    id: row.id,
    ingredientId: row.ingredientId,
    displayName: row.displayName,
    quantity: numberOrNull(row.quantity),
    unit: row.unit,
    aisle: row.aisle,
    origin: row.origin as GroceryLineOrigin,
    checked: row.checked,
    coveredByPantry: row.coveredByPantry,
    useSoon: matchesCoverage(
      row,
      coverage.useSoonIngredientIds,
      coverage.useSoonNames,
    ),
    optional: row.optional,
    unmergeableGroup: row.unmergeableGroup,
    sourceEntryIds: row.sourceEntryIds,
  };
}
