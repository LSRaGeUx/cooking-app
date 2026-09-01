import { and, asc, eq, inArray } from "drizzle-orm";
import { groceryLine, groceryList, plan, planEntry, planVersion } from "@/db/schema";
import { normalizeTerm } from "@/domain/allergens";
import { DomainError } from "@/domain/errors";
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
 * Pantry subtraction is phase 7. The column is already there and every line is
 * written with `coveredByPantry` false until then.
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
  readonly unmergeableGroup: string | null;
  readonly sourceEntryIds: string[];
}

export interface GroceryEntrySource {
  readonly entryId: string;
  readonly dayOfWeek: number;
  readonly title: string;
}

export interface GroceryListView {
  readonly id: string;
  readonly state: string;
  readonly planVersionId: string;
  readonly planVersionNumber: number;
  /** True when the list was generated from a version that is no longer active. */
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
  week: unknown,
): Promise<GroceryListView | null> {
  const isoWeek = isoWeekSchema.parse(week);

  return inScope(ctx, async (tx) => {
    const scoped = { ...ctx, tx };
    const found = await findLiveList(scoped, isoWeek);
    if (!found) return null;
    return loadListView(scoped, found.listId);
  });
}

/**
 * Generates the list for a week, or merges into the one that is already there.
 * Always runs against the week's active version, because that is the plan the
 * user is actually going to cook.
 */
export async function generateGroceryList(
  ctx: ServiceContext,
  week: unknown,
): Promise<GenerateResult> {
  const isoWeek = isoWeekSchema.parse(week);

  return inScope(ctx, async (tx) => {
    const scoped = { ...ctx, tx };
    const active = await findActiveVersion(scoped, isoWeek);
    if (!active) {
      throw new DomainError(
        "NOT_FOUND",
        `Aucune semaine active pour ${isoWeek.year}-W${isoWeek.week}. Planifiez au moins un repas avant de générer une liste de courses.`,
        { year: isoWeek.year, week: isoWeek.week },
      );
    }

    const aggregated = await aggregateForVersion(scoped, active.id);
    const existing = await findLiveList(scoped, isoWeek);

    if (!existing) {
      const created = await tx
        .insert(groceryList)
        .values({
          userId: ctx.userId,
          planVersionId: active.id,
          state: "active",
        })
        .returning({ id: groceryList.id });

      const listId = created[0]!.id;
      const inserted = await insertDerivedLines(scoped, listId, aggregated);

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

    const diff = await mergeIntoList(scoped, existing.listId, aggregated);
    await tx
      .update(groceryList)
      .set({ planVersionId: active.id, updatedAt: new Date() })
      .where(eq(groceryList.id, existing.listId));

    return { list: await loadListView(scoped, existing.listId), diff };
  });
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
    return toLineView(rows[0]!);
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
async function aggregateForVersion(
  ctx: ServiceContext & { tx: NonNullable<ServiceContext["tx"]> },
  planVersionId: string,
): Promise<AggregatedGroceryLine[]> {
  const entries = await ctx.tx
    .select({
      id: planEntry.id,
      recipeId: planEntry.recipeId,
      servings: planEntry.servings,
    })
    .from(planEntry)
    .where(eq(planEntry.planVersionId, planVersionId));

  const recipeIds = [
    ...new Set(
      entries
        .map((entry) => entry.recipeId)
        .filter((id): id is string => id !== null),
    ),
  ];
  const baskets = await loadRecipeBaskets(ctx, recipeIds);

  const sourceLines: GrocerySourceLine[] = [];
  for (const entry of entries) {
    if (entry.recipeId === null) continue;
    const basket = baskets.get(entry.recipeId);
    if (!basket) continue;

    for (const line of basket.lines) {
      sourceLines.push({
        entryId: entry.id,
        ingredientId: line.ingredientId,
        displayName: line.displayName,
        aisle: line.aisle,
        quantity: scaleQuantity(line.quantity, basket.servings, entry.servings),
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
    const key = matchKey(line.ingredientId, line.displayName, line.unit);
    seen.add(key);
    const existing = byKey.get(key);

    if (!existing) {
      const inserted = await tx
        .insert(groceryLine)
        .values(derivedValues(ctx.userId, listId, line))
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
): Promise<string[]> {
  if (lines.length === 0) return [];
  const inserted = await ctx.tx
    .insert(groceryLine)
    .values(lines.map((line) => derivedValues(ctx.userId, listId, line)))
    .returning({ id: groceryLine.id });
  return inserted.map((row) => row.id);
}

function derivedValues(
  userId: string,
  listId: string,
  line: AggregatedGroceryLine,
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
    unmergeableGroup: line.unmergeableGroup,
  };
}

/**
 * How a stored line is recognised as "the same line" on the next generation.
 * The unit is part of it because an ingredient can legitimately hold several
 * lines that could not be summed.
 */
function matchKey(
  ingredientId: string | null,
  displayName: string,
  unit: string | null,
): string {
  return `${ingredientId ?? ""}|${normalizeTerm(displayName)}|${unit ?? ""}`;
}

function matchKeyOfRow(row: typeof groceryLine.$inferSelect): string {
  return matchKey(row.ingredientId, row.displayName, row.unit);
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
 * The live list for a week, found by joining through the version it was last
 * generated from. A list belongs to a week; the version it points at is only
 * the one it was last built from.
 */
async function findLiveList(
  ctx: ServiceContext & { tx: NonNullable<ServiceContext["tx"]> },
  isoWeek: IsoWeek,
): Promise<{ listId: string } | null> {
  const rows = await ctx.tx
    .select({ listId: groceryList.id })
    .from(groceryList)
    .innerJoin(planVersion, eq(planVersion.id, groceryList.planVersionId))
    .innerJoin(plan, eq(plan.id, planVersion.planId))
    .where(
      and(
        eq(groceryList.userId, ctx.userId),
        eq(plan.isoYear, isoWeek.year),
        eq(plan.isoWeek, isoWeek.week),
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
      planVersionId: groceryList.planVersionId,
      generatedAt: groceryList.generatedAt,
      updatedAt: groceryList.updatedAt,
      versionNumber: planVersion.versionNumber,
      versionState: planVersion.state,
    })
    .from(groceryList)
    .innerJoin(planVersion, eq(planVersion.id, groceryList.planVersionId))
    .where(eq(groceryList.id, listId))
    .limit(1);

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

  const entryIds = [...new Set(lines.flatMap((line) => line.sourceEntryIds))];
  const sources =
    entryIds.length === 0
      ? []
      : await tx
          .select({
            entryId: planEntry.id,
            dayOfWeek: planEntry.dayOfWeek,
            title: planEntry.recipeTitleSnapshot,
          })
          .from(planEntry)
          .where(inArray(planEntry.id, entryIds));

  return {
    id: list.id,
    state: list.state,
    planVersionId: list.planVersionId,
    planVersionNumber: list.versionNumber,
    // A list built from a superseded version is still perfectly shoppable; the
    // screen just says so and offers to regenerate.
    stale: list.versionState !== "active",
    generatedAt: list.generatedAt,
    updatedAt: list.updatedAt,
    lines: lines.map(toLineView).sort(compareLines),
    sources,
  };
}

function toLineView(row: typeof groceryLine.$inferSelect): GroceryLineView {
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
    unmergeableGroup: row.unmergeableGroup,
    sourceEntryIds: row.sourceEntryIds,
  };
}

function numberOrNull(value: string | null): number | null {
  return value === null ? null : Number(value);
}
