import { sql } from "drizzle-orm";
import {
  budgetSuggestions,
  unresolvedSignals,
  type BudgetSuggestion,
  type RecipeStats,
  type SlotStats,
  type UnresolvedSignal,
} from "@/domain/signals";
import { isoWeekOf, shiftIsoWeek, weeksBetween } from "@/domain/week";
import { inScope, type ServiceContext } from "./context";
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
 */

export async function loadRecipeStats(
  ctx: ServiceContext,
  now: Date = new Date(),
): Promise<RecipeStats[]> {
  return inScope(ctx, async (tx) => {
    const rows = await tx.execute<{
      recipe_id: string;
      title: string;
      planned: number;
      cooked: number;
      skipped: number;
      swapped: number;
      average_rating: string | null;
      last_cooked_key: number | null;
    }>(sql`
      select pe.recipe_id                                        as recipe_id,
             max(pe.recipe_title_snapshot)                       as title,
             count(*)::int                                       as planned,
             count(*) filter (where f.outcome = 'cooked')::int    as cooked,
             count(*) filter (where f.outcome = 'skipped')::int   as skipped,
             count(*) filter (where f.outcome = 'swapped')::int   as swapped,
             avg(f.rating) filter (where f.rating is not null)    as average_rating,
             max(p.iso_year * 100 + p.iso_week)
               filter (where f.outcome = 'cooked')                as last_cooked_key
      from plan_entry pe
      join plan_version pv on pv.id = pe.plan_version_id
      join plan p on p.id = pv.plan_id
      left join entry_feedback f on f.plan_entry_id = pe.id
      where pv.state = 'active'
        and pe.recipe_id is not null
      group by pe.recipe_id
    `);

    const thisWeek = isoWeekOf(now);

    return rows.rows.map((row) => ({
      recipeId: row.recipe_id,
      title: row.title,
      planned: row.planned,
      cooked: row.cooked,
      skipped: row.skipped,
      swapped: row.swapped,
      averageRating:
        row.average_rating === null ? null : Number(row.average_rating),
      weeksSinceLastCooked:
        row.last_cooked_key === null
          ? null
          : weeksBetween(
              {
                year: Math.floor(row.last_cooked_key / 100),
                week: row.last_cooked_key % 100,
              },
              thisWeek,
            ),
    }));
  });
}

export async function loadSlotStats(
  ctx: ServiceContext,
): Promise<SlotStats[]> {
  return inScope(ctx, async (tx) => {
    const scoped = { ...ctx, tx };
    const slots = await loadSlotDefinitions(scoped);

    const rows = await tx.execute<{
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
      where pv.state = 'active'
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
  });
}

export interface HistoryEntry {
  readonly dayOfWeek: number;
  readonly recipeTitle: string;
  readonly servings: number;
  readonly outcome: string | null;
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

  return inScope(ctx, async (tx) => {
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
      where pv.state = 'active'
        and (p.iso_year * 100 + p.iso_week) >= ${fromKey}
      order by p.iso_year desc, p.iso_week desc, pe.day_of_week asc
    `);

    const weeks = new Map<string, HistoryWeek>();
    for (const row of rows.rows) {
      const key = `${row.iso_year}-${row.iso_week}`;
      const existing = weeks.get(key) ?? {
        year: row.iso_year,
        week: row.iso_week,
        entries: [],
      };
      existing.entries.push({
        dayOfWeek: row.day_of_week,
        recipeTitle: row.recipe_title_snapshot,
        servings: row.servings,
        outcome: row.outcome,
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
  return inScope(ctx, async (tx) => {
    const scoped = { ...ctx, tx };
    const recipes = await loadRecipeStats(scoped, now);
    const slots = await loadSlotStats(scoped);
    return {
      signals: unresolvedSignals(recipes, slots),
      budgetSuggestions: budgetSuggestions(slots),
    };
  });
}
