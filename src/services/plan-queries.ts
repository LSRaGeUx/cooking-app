import { and, asc, desc, eq, sql } from "drizzle-orm";
import { plan, planEntry, planVersion } from "@/db/schema";
import { DomainError } from "@/domain/errors";
import {
  isoWeekSchema,
  slotSnapshotSchema,
  type SlotSnapshot,
} from "@/domain/schemas";
import type { SlotDefinition } from "@/domain/slots";
import type { PlanAuthor, PlanVersionState } from "@/domain/vocabulary";
import type { IsoDay, IsoWeek } from "@/domain/week";
import { inScope, type ScopedContext, type ServiceContext } from "./context";
import { loadSlotDefinitions } from "./slot-service";

/**
 * Reading plans. Extracted from plan-service.ts, and the extraction is not only
 * about file length.
 *
 * The prep service needs a week's entries, and the plan service needs to create
 * prep links, so the two imported each other: a cycle that happened to work
 * because both sides are hoisted function declarations, and which would have
 * broken the day either one gained a module-level constant that ran at import
 * time. Both now read the week from here, and the plan service is the only one
 * that depends on the prep service.
 */

export interface PlanEntryView {
  readonly id: string;
  /**
   * The ISO day union, not `number`. `check plan_entry_day_range` bounds the
   * column at 1 to 7, so this is the type the value has always had, and half
   * the readers were casting it back at the point of use.
   */
  readonly dayOfWeek: IsoDay;
  readonly mealTypeId: string;
  readonly recipeId: string | null;
  readonly recipeTitleSnapshot: string;
  readonly recipeRevisionSnapshot: number | null;
  readonly servings: number;
  readonly note: string | null;
  readonly rationale: string | null;
  /** Fact, feedback or pantry ids the agent cited when it chose this dish. */
  readonly rationaleRefs: string[];
  readonly position: number;
}

export interface PlanVersionView {
  readonly id: string;
  readonly versionNumber: number;
  /** The vocabulary unions rather than `string`; both columns are constrained. */
  readonly state: PlanVersionState;
  readonly createdBy: PlanAuthor;
  readonly summary: string | null;
  readonly createdAt: Date;
  readonly activatedAt: Date | null;
  /**
   * The grid this version was created with, parsed, or null when the stored
   * value does not match the current shape.
   *
   * Null and `[]` mean different things and both are reachable: `[]` is a
   * version created with no slots configured, null is a snapshot written by an
   * older build that this one can no longer read. Collapsing them would render
   * "we cannot read this" as "nothing was configured".
   */
  readonly slotSnapshot: SlotSnapshot | null;
}

export interface WeekView {
  readonly isoWeek: IsoWeek;
  readonly planId: string | null;
  readonly activeVersion: PlanVersionView | null;
  readonly pendingVersion: PlanVersionView | null;
  readonly slots: SlotDefinition[];
  readonly entries: PlanEntryView[];
  /** Entries whose slot is no longer planned. Kept, never silently dropped. */
  readonly orphanedEntries: PlanEntryView[];
}

/** `4:uuid`, the one key a (day, meal) pair is ever turned into. */
export function slotKey(dayOfWeek: number, mealTypeId: string): string {
  return `${dayOfWeek}:${mealTypeId}`;
}

/**
 * A slot key that also separates the dishes within one slot, for the diff and
 * the remap: a slot can hold several dishes, and comparing them by slot alone
 * compares the first of each.
 */
export function entryKey(
  entry: Pick<PlanEntryView, "dayOfWeek" | "mealTypeId" | "position">,
): string {
  return `${entry.dayOfWeek}:${entry.mealTypeId}:${entry.position}`;
}

export async function getWeekView(
  ctx: ServiceContext,
  week: unknown,
): Promise<WeekView> {
  const isoWeek = isoWeekSchema.parse(week);

  return inScope(ctx, async (scoped) => {
    const slots = await loadSlotDefinitions(scoped);

    const planRow = await findPlan(scoped, isoWeek);
    if (!planRow) {
      // No implicit plan creation: an unvisited week is plannable, not planned.
      return {
        isoWeek,
        planId: null,
        activeVersion: null,
        pendingVersion: null,
        slots,
        entries: [],
        orphanedEntries: [],
      };
    }

    const versions = await listVersionRows(scoped, planRow.id);

    const active = versions.find((version) => version.state === "active");
    const pending = versions.find((version) => version.state === "pending");
    const entries = active ? await loadEntries(scoped, active.id) : [];

    const planned = new Set(
      slots
        .filter((slot) => slot.state === "planned")
        .map((slot) => slotKey(slot.dayOfWeek, slot.mealTypeId)),
    );

    return {
      isoWeek,
      planId: planRow.id,
      activeVersion: active ? toVersionView(active) : null,
      pendingVersion: pending ? toVersionView(pending) : null,
      slots,
      entries: entries.filter((entry) =>
        planned.has(slotKey(entry.dayOfWeek, entry.mealTypeId)),
      ),
      orphanedEntries: entries.filter(
        (entry) => !planned.has(slotKey(entry.dayOfWeek, entry.mealTypeId)),
      ),
    };
  });
}

export async function listVersions(
  ctx: ServiceContext,
  week: unknown,
): Promise<PlanVersionView[]> {
  const isoWeek = isoWeekSchema.parse(week);
  return inScope(ctx, async (scoped) => {
    const planRow = await findPlan(scoped, isoWeek);
    if (!planRow) return [];
    const rows = await listVersionRows(scoped, planRow.id);
    return rows.map(toVersionView);
  });
}

export async function getVersionEntries(
  ctx: ServiceContext,
  planVersionId: string,
): Promise<PlanEntryView[]> {
  return inScope(ctx, (scoped) => loadEntries(scoped, planVersionId));
}

/** The plan row for a week, or null. */
export async function findPlan(ctx: ScopedContext, isoWeek: IsoWeek) {
  const rows = await ctx.tx
    .select()
    .from(plan)
    .where(
      and(
        eq(plan.userId, ctx.userId),
        eq(plan.isoYear, isoWeek.year),
        eq(plan.isoWeek, isoWeek.week),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The plan row for a week, created if this user has never touched it.
 *
 * The week is parsed with `isoWeekSchema` here as well as at the entry points.
 * The refinement that refuses a week the year does not have lives on that
 * schema, and a `.shape` spread drops it, so a caller that rebuilt the object
 * from the shape would arrive with 2026-W53 and get a plan row written for a
 * week that does not exist. Parsing again costs one date computation and closes
 * the hole wherever a new caller comes from.
 *
 * `lock` takes `for update` on the row, which is what a write needs before it
 * reads the version numbers: see `mutateWeek`.
 */
export async function ensurePlan(
  ctx: ScopedContext,
  week: IsoWeek,
  options: { lock?: boolean } = {},
) {
  const isoWeek = isoWeekSchema.parse(week);
  const found = await findOrCreatePlan(ctx, isoWeek);
  if (options.lock === true) await lockPlan(ctx, found.id);
  return found;
}

async function findOrCreatePlan(ctx: ScopedContext, isoWeek: IsoWeek) {
  const existing = await findPlan(ctx, isoWeek);
  if (existing) return existing;

  const inserted = await ctx.tx
    .insert(plan)
    .values({
      userId: ctx.userId,
      isoYear: isoWeek.year,
      isoWeek: isoWeek.week,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return inserted[0];

  // Lost a race with a concurrent first write. The row exists now.
  const reread = await findPlan(ctx, isoWeek);
  if (!reread) {
    throw new DomainError(
      "VALIDATION",
      `La semaine ${isoWeek.year}-W${String(isoWeek.week).padStart(2, "0")} n'a pas pu être créée.`,
      { year: isoWeek.year, week: isoWeek.week },
    );
  }
  return reread;
}

/**
 * Serializes the writers of one plan.
 *
 * Version numbering is read-modify-write: the next number is the highest
 * existing one plus one, and the partial unique indexes allow one active and
 * one pending version per plan. Two concurrent writes therefore computed the
 * same number and the loser got a raw `23505` from
 * `plan_version_plan_number_key` or `plan_version_one_active_idx`, which
 * reaches an agent as an opaque failure rather than as `VERSION_CONFLICT` with
 * the current state attached. Locking the parent plan row makes the second
 * writer wait and then read the first one's version.
 */
async function lockPlan(ctx: ScopedContext, planId: string): Promise<void> {
  await ctx.tx.execute(
    sql`select id from plan where id = ${planId} and user_id = ${ctx.userId} for update`,
  );
}

/** The version of a plan in a given state, or null. */
export async function findVersion(
  ctx: ScopedContext,
  planId: string,
  state: PlanVersionState,
) {
  const rows = await ctx.tx
    .select()
    .from(planVersion)
    .where(
      and(
        eq(planVersion.userId, ctx.userId),
        eq(planVersion.planId, planId),
        eq(planVersion.state, state),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The active version of a week, found from the week rather than from a plan id.
 *
 * The grocery service kept its own join for this, which was `findPlan` plus
 * `findVersion` written as one query. One statement of it lives here, where the
 * plan reads are.
 */
export async function findActivePlanVersion(
  ctx: ScopedContext,
  isoWeek: IsoWeek,
): Promise<{ id: string; versionNumber: number } | null> {
  const planRow = await findPlan(ctx, isoWeek);
  if (!planRow) return null;
  const version = await findVersion(ctx, planRow.id, "active");
  return version
    ? { id: version.id, versionNumber: version.versionNumber }
    : null;
}

/**
 * The plan and its pending version, or NOT_FOUND. Three functions in the
 * proposal service opened with the same twelve lines.
 */
export async function requirePendingVersion(
  ctx: ScopedContext,
  isoWeek: IsoWeek,
): Promise<{
  planId: string;
  pending: typeof planVersion.$inferSelect;
}> {
  const planRow = await findPlan(ctx, isoWeek);
  const pending = planRow
    ? await findVersion(ctx, planRow.id, "pending")
    : null;
  if (!planRow || !pending) {
    throw new DomainError(
      "NOT_FOUND",
      "Aucune proposition en attente pour cette semaine.",
      { year: isoWeek.year, week: isoWeek.week },
    );
  }
  return { planId: planRow.id, pending };
}

export async function listVersionRows(ctx: ScopedContext, planId: string) {
  return ctx.tx
    .select()
    .from(planVersion)
    .where(
      and(eq(planVersion.userId, ctx.userId), eq(planVersion.planId, planId)),
    )
    .orderBy(desc(planVersion.versionNumber));
}

export async function loadEntries(
  ctx: ScopedContext,
  planVersionId: string,
): Promise<PlanEntryView[]> {
  const rows = await ctx.tx
    .select({
      id: planEntry.id,
      dayOfWeek: planEntry.dayOfWeek,
      mealTypeId: planEntry.mealTypeId,
      recipeId: planEntry.recipeId,
      recipeTitleSnapshot: planEntry.recipeTitleSnapshot,
      recipeRevisionSnapshot: planEntry.recipeRevisionSnapshot,
      servings: planEntry.servings,
      note: planEntry.note,
      rationale: planEntry.rationale,
      rationaleRefs: planEntry.rationaleRefs,
      position: planEntry.position,
    })
    .from(planEntry)
    .where(
      and(
        eq(planEntry.userId, ctx.userId),
        eq(planEntry.planVersionId, planVersionId),
      ),
    )
    .orderBy(asc(planEntry.dayOfWeek), asc(planEntry.position));

  return rows.map((row) => ({
    ...row,
    // `check plan_entry_day_range` bounds the column at 1 to 7, so the narrowing
    // is a claim the database already enforces rather than a guess.
    dayOfWeek: row.dayOfWeek as IsoDay,
    // `not null default '[]'::jsonb` and `$type<string[]>()`, so the column
    // hands back an array. The old `Array.isArray` guard and `as string[]` cast
    // existed because the column was nullable and untyped.
    rationaleRefs: row.rationaleRefs,
  }));
}

export function toVersionView(
  row: typeof planVersion.$inferSelect,
): PlanVersionView {
  return {
    id: row.id,
    versionNumber: row.versionNumber,
    // `text` plus a check constraint in both cases, narrowed here rather than
    // at every reader.
    state: row.state as PlanVersionState,
    createdBy: row.createdBy as PlanAuthor,
    summary: row.summary,
    createdAt: row.createdAt,
    activatedAt: row.activatedAt,
    // `$type<SlotSnapshot>()` is a compile-time claim about a jsonb value, so
    // it is parsed rather than trusted: a version written before the snapshot
    // shape changed satisfies the type and not the schema. Reading a week must
    // not fail because a version from two builds ago is unreadable, so the
    // failure becomes null and the caller decides what to say about it.
    slotSnapshot: slotSnapshotSchema.safeParse(row.slotSnapshot).data ?? null,
  };
}
