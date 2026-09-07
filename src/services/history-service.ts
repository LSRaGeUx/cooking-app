import { sql } from "drizzle-orm";
import {
  budgetSuggestions,
  unresolvedSignals,
  type BudgetSuggestion,
  type RecipeStats,
  type SlotStats,
  type UnresolvedSignal,
} from "@/domain/signals";
import type { FeedbackOutcome } from "@/domain/vocabulary";
import {
  isoWeekOf,
  shiftIsoWeek,
  weeksBetween,
  type IsoWeek,
} from "@/domain/week";
import { inScope, type ScopedContext, type ServiceContext } from "./context";
import { loadSlotDefinitions } from "./slot-service";

/**
 * The derived read models: cook rate, rotation age, overruns.
 *
 * Computed on demand rather than stored, because they are cheap at this scale
 * and a materialized copy is one more thing that can be wrong. If the library
 * grows past a few hundred recipes this is the file to add aggregates to.
 *
 * The line this file does not cross: it derives signals, never facts. It can
 * say a dish was planned three times and never cooked. Concluding that the
 * person dislikes it is the agent's job, with low confidence and cited
 * evidence, because a fact store that fills itself stops being honest about
 * where its claims came from.
 *
 * Every query here carries `pe.user_id` explicitly. They relied entirely on
 * row-level security, which rule 8 makes the second line and not the only one,
 * and `loadRecipeIndex` in the recipe service already wrote the predicate for
 * the same query, so the two statements of one aggregate did not even agree
 * about that.
 */

/**
 * The one plan-and-feedback aggregate per recipe.
 *
 * It existed twice: here, as `loadRecipeStats`, and in the recipe service, as
 * the query behind `loadRecipeIndex`. Both counted plans and cooked meals and
 * averaged ratings over the same join, and they had already drifted (one
 * scoped by user, the other did not; one collected skipped and swapped counts,
 * the other the last planned week). One query answers both, and the callers
 * pick the columns they need.
 *
 * Only active versions count. A superseded version is a plan that was replaced,
 * so counting it would say a recipe was planned when it was not.
 */
export interface RecipeHistoryAggregate {
  readonly recipeId: string;
  /** The title as it was snapshotted, so a deleted recipe still has a name. */
  readonly title: string;
  readonly planned: number;
  readonly cooked: number;
  readonly skipped: number;
  readonly swapped: number;
  readonly averageRating: number | null;
  /** `year * 100 + week` of the last active plan that carried it. */
  readonly lastPlannedKey: number | null;
  /** The same key, restricted to the weeks it was actually cooked. */
  readonly lastCookedKey: number | null;
}

export async function recipeHistoryAggregate(
  ctx: ServiceContext,
): Promise<Map<string, RecipeHistoryAggregate>> {
  return inScope(ctx, async ({ tx }) => {
    const rows = await tx.execute<{
      recipe_id: string;
      title: string;
      planned: number;
      cooked: number;
      skipped: number;
      swapped: number;
      average_rating: string | null;
      last_planned_key: number | null;
      last_cooked_key: number | null;
    }>(sql`
      select pe.recipe_id                                        as recipe_id,
             max(pe.recipe_title_snapshot)                       as title,
             count(*)::int                                       as planned,
             count(*) filter (where f.outcome = 'cooked')::int    as cooked,
             count(*) filter (where f.outcome = 'skipped')::int   as skipped,
             count(*) filter (where f.outcome = 'swapped')::int   as swapped,
             avg(f.rating) filter (where f.rating is not null)    as average_rating,
             max(p.iso_year * 100 + p.iso_week)                   as last_planned_key,
             max(p.iso_year * 100 + p.iso_week)
               filter (where f.outcome = 'cooked')                as last_cooked_key
      from plan_entry pe
      join plan_version pv on pv.id = pe.plan_version_id
      join plan p on p.id = pv.plan_id
      left join entry_feedback f on f.plan_entry_id = pe.id
      where pe.user_id = ${ctx.userId}
        and pv.state = 'active'
        and pe.recipe_id is not null
      group by pe.recipe_id
    `);

    return new Map(
      rows.rows.map((row) => [
        row.recipe_id,
        {
          recipeId: row.recipe_id,
          title: row.title,
          planned: row.planned,
          cooked: row.cooked,
          skipped: row.skipped,
          swapped: row.swapped,
          averageRating:
            row.average_rating === null ? null : Number(row.average_rating),
          lastPlannedKey: row.last_planned_key,
          lastCookedKey: row.last_cooked_key,
        },
      ]),
    );
  });
}

/**
 * Weeks from a stored `year * 100 + week` key to a given week, or null when the
 * key is absent. The key encoding orders correctly across a year boundary and
 * across a 53-week year, unlike a bare week number.
 *
 * Exported because the recipe index derives two of its fields from it, and this
 * is where the encoding is decided.
 */
export function weeksSinceKey(
  key: number | null,
  thisWeek: IsoWeek,
): number | null {
  if (key === null) return null;
  return weeksBetween(
    { year: Math.floor(key / 100), week: key % 100 },
    thisWeek,
  );
}

export async function loadRecipeStats(
  ctx: ServiceContext,
  now: Date = new Date(),
): Promise<RecipeStats[]> {
  const aggregate = await recipeHistoryAggregate(ctx);
  const thisWeek = isoWeekOf(now);

  return [...aggregate.values()].map((row) => ({
    recipeId: row.recipeId,
    title: row.title,
    planned: row.planned,
    cooked: row.cooked,
    skipped: row.skipped,
    swapped: row.swapped,
    averageRating: row.averageRating,
    weeksSinceLastCooked: weeksSinceKey(row.lastCookedKey, thisWeek),
  }));
}

/**
 * Not exported: `loadSignals` below is the whole interface, and nothing outside
 * this file ever asked for the raw slot statistics.
 */
async function loadSlotStats(ctx: ScopedContext): Promise<SlotStats[]> {
  const slots = await loadSlotDefinitions(ctx);

  const rows = await ctx.tx.execute<{
    day_of_week: number;
    meal_type_id: string;
    planned: number;
    with_feedback: number;
    took_longer: number;
    longest_overrun: number | null;
  }>(sql`
    select pe.day_of_week,
           pe.meal_type_id,
           count(*)::int                                     as planned,
           count(f.id)::int                                  as with_feedback,
           count(*) filter (where f.took_longer)::int         as took_longer,
           max(coalesce(r.active_time_min,
                        coalesce(r.prep_time_min, 0) + coalesce(r.cook_time_min, 0)))
             filter (where f.took_longer)                     as longest_overrun
    from plan_entry pe
    join plan_version pv on pv.id = pe.plan_version_id
    left join entry_feedback f on f.plan_entry_id = pe.id
    left join recipe r on r.id = pe.recipe_id
    where pe.user_id = ${ctx.userId}
      and pv.state = 'active'
    group by pe.day_of_week, pe.meal_type_id
  `);

  return rows.rows.map((row) => {
    const slot = slots.find(
      (candidate) =>
        candidate.dayOfWeek === row.day_of_week &&
        candidate.mealTypeId === row.meal_type_id,
    );
    return {
      dayOfWeek: row.day_of_week,
      mealTypeId: row.meal_type_id,
      mealTypeLabel: slot?.mealTypeLabel ?? "",
      timeBudgetMin: slot?.timeBudgetMin ?? null,
      planned: row.planned,
      withFeedback: row.with_feedback,
      tookLonger: row.took_longer,
      longestOverrunMin:
        row.longest_overrun === null ? null : Number(row.longest_overrun),
    };
  });
}

export interface HistoryEntry {
  readonly dayOfWeek: number;
  readonly recipeTitle: string;
  readonly servings: number;
  readonly outcome: FeedbackOutcome | null;
  readonly rating: number | null;
  readonly swappedFor: string | null;
  readonly tookLonger: boolean;
  readonly note: string | null;
}

export interface HistoryWeek {
  readonly year: number;
  readonly week: number;
  readonly entries: HistoryEntry[];
}

/**
 * What was planned and what happened, week by week. Only weeks that have an
 * active version appear; a week nobody planned is not history, it is silence.
 */
export async function loadHistory(
  ctx: ServiceContext,
  weeksBack = 8,
  now: Date = new Date(),
): Promise<HistoryWeek[]> {
  const from = shiftIsoWeek(isoWeekOf(now), -Math.max(1, weeksBack));
  const fromKey = from.year * 100 + from.week;

  return inScope(ctx, async ({ tx }) => {
    const rows = await tx.execute<{
      iso_year: number;
      iso_week: number;
      day_of_week: number;
      recipe_title_snapshot: string;
      servings: number;
      outcome: string | null;
      rating: number | null;
      swapped_for: string | null;
      took_longer: boolean | null;
      note: string | null;
    }>(sql`
      select p.iso_year, p.iso_week, pe.day_of_week,
             pe.recipe_title_snapshot, pe.servings,
             f.outcome, f.rating, f.swapped_for, f.took_longer, f.note
      from plan_entry pe
      join plan_version pv on pv.id = pe.plan_version_id
      join plan p on p.id = pv.plan_id
      left join entry_feedback f on f.plan_entry_id = pe.id
      where pe.user_id = ${ctx.userId}
        and pv.state = 'active'
        and (p.iso_year * 100 + p.iso_week) >= ${fromKey}
      order by p.iso_year desc, p.iso_week desc, pe.day_of_week asc
    `);

    const weeks = new Map<string, HistoryWeek>();
    for (const row of rows.rows) {
      const key = `${row.iso_year}-${row.iso_week}`;
      const existing: HistoryWeek = weeks.get(key) ?? {
        year: row.iso_year,
        week: row.iso_week,
        entries: [],
      };
      existing.entries.push({
        dayOfWeek: row.day_of_week,
        recipeTitle: row.recipe_title_snapshot,
        servings: row.servings,
        outcome: row.outcome as FeedbackOutcome | null,
        rating: row.rating,
        swappedFor: row.swapped_for,
        tookLonger: row.took_longer ?? false,
        note: row.note,
      });
      weeks.set(key, existing);
    }

    return [...weeks.values()];
  });
}

export interface SignalReport {
  readonly signals: UnresolvedSignal[];
  readonly budgetSuggestions: BudgetSuggestion[];
}

export async function loadSignals(
  ctx: ServiceContext,
  now: Date = new Date(),
): Promise<SignalReport> {
  return inScope(ctx, async (scoped) => {
    const recipes = await loadRecipeStats(scoped, now);
    const slots = await loadSlotStats(scoped);
    return {
      signals: unresolvedSignals(recipes, slots),
      budgetSuggestions: budgetSuggestions(slots),
    };
  });
}
