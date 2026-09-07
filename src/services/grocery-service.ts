import { and, asc, eq, inArray, ne } from "drizzle-orm";
import {
  groceryLine,
  groceryList,
  groceryListVersion,
  plan,
  planEntry,
  planVersion,
} from "@/db/schema";
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
import { isoWeekSchema } from "@/domain/schemas";
import type { IsoWeek } from "@/domain/week";
import { inScope, type ServiceContext } from "./context";
import { loadPantryCoverage, type PantryCoverage } from "./pantry-service";
import { loadPrepLinks } from "./prep-service";
import { loadRecipeBaskets } from "./recipe-service";

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
  readonly origin: string;
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
  readonly state: string;
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

  return inScope(ctx, async (tx) => {
    const scoped = { ...ctx, tx };
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

  return inScope(ctx, async (tx) => {
    const scoped = { ...ctx, tx };
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
    const existing = await findLiveList(scoped, cycle);

    if (!existing) {
      const created = await tx
        .insert(groceryList)
        .values({
          userId: ctx.userId,
          startsOn: formatCycleStart(cycle.startsOn),
          endsOn: formatCycleStart(cycle.endsOn),
          state: "active",
        })
        .returning({ id: groceryList.id });

      const listId = created[0]!.id;
      await recordVersions(scoped, listId, versions);
      const inserted = await insertDerivedLines(
        scoped,
        listId,
        aggregated,
        coverage,
      );

      return {
        list: await loadListView(scoped, listId),
        diff: {
          added: inserted.length,
          updated: 0,
          unchanged: 0,
          removed: 0,
          changedLineIds: inserted,
        },
      };
    }

    const diff = await mergeIntoList(
      scoped,
      existing.listId,
      aggregated,
      coverage,
    );
    await recordVersions(scoped, existing.listId, versions);
    await tx
      .update(groceryList)
      .set({ updatedAt: new Date() })
      .where(eq(groceryList.id, existing.listId));

    return { list: await loadListView(scoped, existing.listId), diff };
  });
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
  await inScope(ctx, async (tx) => {
    const rows = await tx
      .update(groceryLine)
      .set({ checked })
      .where(eq(groceryLine.id, lineId))
      .returning({ id: groceryLine.id });
    if (!rows[0]) {
      throw new DomainError("NOT_FOUND", "Cette ligne n'existe pas.", { lineId });
    }
  });
}

export interface ManualLineInput {
  readonly displayName: string;
  readonly quantity?: number | null;
  readonly unit?: string | null;
  readonly aisle?: string | null;
}

/**
 * Coffee, dish soap, the things no recipe knows about. Manual lines are never
 * touched by a regeneration.
 */
export async function addManualLine(
  ctx: ServiceContext,
  listId: string,
  input: ManualLineInput,
): Promise<GroceryLineView> {
  const displayName = input.displayName.trim();
  if (displayName.length === 0 || displayName.length > 200) {
    throw new DomainError(
      "VALIDATION",
      "Le nom d'une ligne manuelle doit faire entre 1 et 200 caractères.",
      { displayName: input.displayName },
    );
  }

  return inScope(ctx, async (tx) => {
    await requireList({ ...ctx, tx }, listId);
    const rows = await tx
      .insert(groceryLine)
      .values({
        userId: ctx.userId,
        groceryListId: listId,
        displayName,
        quantity: input.quantity === null || input.quantity === undefined
          ? null
          : String(input.quantity),
        unit: input.unit ?? null,
        aisle: input.aisle ?? null,
        origin: "manual",
      })
      .returning();
    return toLineView(rows[0]!, await loadPantryCoverage({ ...ctx, tx }));
  });
}

export async function deleteLine(
  ctx: ServiceContext,
  lineId: string,
): Promise<void> {
  await inScope(ctx, async (tx) => {
    await tx.delete(groceryLine).where(eq(groceryLine.id, lineId));
  });
}

export async function archiveGroceryList(
  ctx: ServiceContext,
  listId: string,
): Promise<void> {
  await inScope(ctx, async (tx) => {
    await tx
      .update(groceryList)
      .set({ state: "archived", updatedAt: new Date() })
      .where(eq(groceryList.id, listId));
  });
}

/**
 * Reads the week's entries, scales every recipe to the servings the entry asks
 * for, and aggregates. Soft-deleted recipes still contribute: the meal is still
 * planned, and the shopper still needs the ingredients.
 */
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
  ctx: ServiceContext & { tx: NonNullable<ServiceContext["tx"]> },
  cycle: ShoppingCycle,
): Promise<CycleVersion[]> {
  const found: CycleVersion[] = [];
  for (const week of isoWeeksInCycle(cycle)) {
    const active = await findActiveVersion(ctx, week);
    if (active) found.push({ ...active, week });
  }
  return found;
}

/** Rewritten on every regeneration, so staleness always reflects the last build. */
async function recordVersions(
  ctx: ServiceContext & { tx: NonNullable<ServiceContext["tx"]> },
  listId: string,
  versions: readonly CycleVersion[],
): Promise<void> {
  await ctx.tx
    .delete(groceryListVersion)
    .where(eq(groceryListVersion.groceryListId, listId));

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
  ctx: ServiceContext & { tx: NonNullable<ServiceContext["tx"]> },
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
      inArray(
        planEntry.planVersionId,
        versions.map((version) => version.id),
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
  const drawnBySource = new Map<string, number>();
  for (const link of links) {
    if (!link.sourceEntryId) continue;
    drawnBySource.set(
      link.sourceEntryId,
      (drawnBySource.get(link.sourceEntryId) ?? 0) + link.servingsDrawn,
    );
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

    const servings = entry.servings + (drawnBySource.get(entry.id) ?? 0);

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
 */
async function mergeIntoList(
  ctx: ServiceContext & { tx: NonNullable<ServiceContext["tx"]> },
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
        eq(groceryLine.groceryListId, listId),
        eq(groceryLine.origin, "derived"),
      ),
    );

  const byKey = new Map(current.map((row) => [matchKeyOfRow(row), row]));
  const changedLineIds: string[] = [];
  let added = 0;
  let updated = 0;
  let unchanged = 0;

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
      const inserted = await tx
        .insert(groceryLine)
        .values(derivedValues(ctx.userId, listId, line, coverage))
        .returning({ id: groceryLine.id });
      added += 1;
      changedLineIds.push(inserted[0]!.id);
      continue;
    }

    const sameQuantity =
      numberOrNull(existing.quantity) === line.quantity &&
      existing.unit === line.unit;

    await tx
      .update(groceryLine)
      .set({
        quantity: line.quantity === null ? null : String(line.quantity),
        unit: line.unit,
        aisle: line.aisle,
        sourceEntryIds: line.sourceEntryIds,
        // Re-evaluated on every regeneration: a staple added since last time
        // should drop off the list now, not next week.
        coveredByPantry: isCovered(line, coverage),
        unmergeableGroup: line.unmergeableGroup,
      })
      .where(eq(groceryLine.id, existing.id));

    if (sameQuantity) {
      unchanged += 1;
    } else {
      updated += 1;
      changedLineIds.push(existing.id);
    }
  }

  const orphaned = current.filter((row) => !seen.has(matchKeyOfRow(row)));
  if (orphaned.length > 0) {
    await tx.delete(groceryLine).where(
      inArray(
        groceryLine.id,
        orphaned.map((row) => row.id),
      ),
    );
  }

  return {
    added,
    updated,
    unchanged,
    removed: orphaned.length,
    changedLineIds,
  };
}

async function insertDerivedLines(
  ctx: ServiceContext & { tx: NonNullable<ServiceContext["tx"]> },
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
    coveredByPantry: isCovered(line, coverage),
    unmergeableGroup: line.unmergeableGroup,
    optional: line.optional,
    productVariant: line.productVariant,
  };
}

/**
 * A line is covered when the pantry says so, by linked ingredient or by name.
 * Matching on the name too is what makes an unlinked staple still useful.
 *
 * The ingredient half is skipped for a product variant: flour in the cupboard
 * does not cover the puff pastry that resolved to it, and a line silently
 * dropped is a dinner that does not happen.
 */
function isCovered(
  line: Pick<
    AggregatedGroceryLine,
    "ingredientId" | "displayName" | "productVariant"
  >,
  coverage: PantryCoverage,
): boolean {
  if (
    line.ingredientId &&
    !line.productVariant &&
    coverage.stapleIngredientIds.has(line.ingredientId)
  ) {
    return true;
  }
  return coverage.stapleNames.has(line.displayName.trim().toLowerCase());
}

function isUseSoon(
  line: {
    ingredientId: string | null;
    displayName: string;
    productVariant: boolean;
  },
  coverage: PantryCoverage,
): boolean {
  if (
    line.ingredientId &&
    !line.productVariant &&
    coverage.useSoonIngredientIds.has(line.ingredientId)
  ) {
    return true;
  }
  return coverage.useSoonNames.has(line.displayName.trim().toLowerCase());
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

async function findActiveVersion(
  ctx: ServiceContext & { tx: NonNullable<ServiceContext["tx"]> },
  isoWeek: IsoWeek,
): Promise<{ id: string; versionNumber: number } | null> {
  const rows = await ctx.tx
    .select({
      id: planVersion.id,
      versionNumber: planVersion.versionNumber,
    })
    .from(planVersion)
    .innerJoin(plan, eq(plan.id, planVersion.planId))
    .where(
      and(
        eq(plan.userId, ctx.userId),
        eq(plan.isoYear, isoWeek.year),
        eq(plan.isoWeek, isoWeek.week),
        eq(planVersion.state, "active"),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The live list for a cycle, found by the date it starts on. A cycle can span
 * two ISO weeks, so there is nothing to join through: the start date is the
 * list's identity.
 */
async function findLiveList(
  ctx: ServiceContext & { tx: NonNullable<ServiceContext["tx"]> },
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

async function requireList(
  ctx: ServiceContext & { tx: NonNullable<ServiceContext["tx"]> },
  listId: string,
): Promise<void> {
  const rows = await ctx.tx
    .select({ id: groceryList.id })
    .from(groceryList)
    .where(eq(groceryList.id, listId))
    .limit(1);
  if (!rows[0]) {
    throw new DomainError("NOT_FOUND", "Cette liste de courses n'existe pas.", {
      listId,
    });
  }
}

async function loadListView(
  ctx: ServiceContext & { tx: NonNullable<ServiceContext["tx"]> },
  listId: string,
): Promise<GroceryListView> {
  const { tx } = ctx;

  const lists = await tx
    .select({
      id: groceryList.id,
      state: groceryList.state,
      startsOn: groceryList.startsOn,
      endsOn: groceryList.endsOn,
      generatedAt: groceryList.generatedAt,
      updatedAt: groceryList.updatedAt,
    })
    .from(groceryList)
    .where(eq(groceryList.id, listId))
    .limit(1);

  const versions = await tx
    .select({ state: planVersion.state })
    .from(groceryListVersion)
    .innerJoin(planVersion, eq(planVersion.id, groceryListVersion.planVersionId))
    .where(eq(groceryListVersion.groceryListId, listId));

  const list = lists[0];
  if (!list) {
    throw new DomainError("NOT_FOUND", "Cette liste de courses n'existe pas.", {
      listId,
    });
  }

  const lines = await tx
    .select()
    .from(groceryLine)
    .where(eq(groceryLine.groceryListId, listId))
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
          .where(inArray(planEntry.id, entryIds));

  return {
    id: list.id,
    state: list.state,
    startsOn: list.startsOn,
    endsOn: list.endsOn,
    // A list built from a superseded version is still perfectly shoppable; the
    // screen just says so and offers to regenerate. A cycle can span two weeks,
    // so one stale contributor is enough.
    stale: versions.some((row) => row.state !== "active"),
    generatedAt: list.generatedAt,
    updatedAt: list.updatedAt,
    lines: lines
      .map((row) => toLineView(row, coverage))
      .sort(compareLines),
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
    origin: row.origin,
    checked: row.checked,
    coveredByPantry: row.coveredByPantry,
    useSoon: isUseSoon(row, coverage),
    optional: row.optional,
    unmergeableGroup: row.unmergeableGroup,
    sourceEntryIds: row.sourceEntryIds,
  };
}

function numberOrNull(value: string | null): number | null {
  return value === null ? null : Number(value);
}
