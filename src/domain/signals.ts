/**
 * The derived signals, and the thresholds that decide when one is worth
 * mentioning.
 *
 * The rule that shapes this file: the app derives signals, never facts. It can
 * say "this was planned three times and never cooked"; it must not conclude
 * "she dislikes it". Turning a signal into a claim about a person is the
 * agent's job, with low confidence and cited evidence, because a fact store
 * that quietly fills itself stops being honest about provenance.
 */

export interface RecipeStats {
  readonly recipeId: string;
  readonly title: string;
  readonly planned: number;
  readonly cooked: number;
  readonly skipped: number;
  readonly swapped: number;
  readonly averageRating: number | null;
  /** Weeks since the last time it was actually cooked, not merely planned. */
  readonly weeksSinceLastCooked: number | null;
}

export interface SlotStats {
  readonly dayOfWeek: number;
  readonly mealTypeId: string;
  readonly mealTypeLabel: string;
  readonly timeBudgetMin: number | null;
  readonly planned: number;
  readonly withFeedback: number;
  readonly tookLonger: number;
  /** Longest attended time among the meals that ran over, when known. */
  readonly longestOverrunMin: number | null;
}

export interface UnresolvedSignal {
  readonly code:
    | "NEVER_COOKED_THOUGH_PLANNED"
    | "SLOT_OVERRUNS"
    | "LOW_RATED_STILL_PLANNED";
  readonly message: string;
  readonly details: Record<string, unknown>;
}

export interface BudgetSuggestion {
  readonly dayOfWeek: number;
  readonly mealTypeId: string;
  readonly mealTypeLabel: string;
  readonly currentBudgetMin: number;
  readonly suggestedBudgetMin: number;
  readonly overrunCount: number;
  readonly observedCount: number;
}

/** Planned at least this often before an absence of cooking means anything. */
export const NEVER_COOKED_MIN_PLANNED = 2;

/** Enough meals in a slot before an overrun rate is more than noise. */
export const OVERRUN_MIN_OBSERVATIONS = 3;

/** Above this share of overruns, the budget is probably wrong, not the cook. */
export const OVERRUN_RATE_THRESHOLD = 0.5;

export function cookRate(stats: RecipeStats): number | null {
  if (stats.planned === 0) return null;
  return stats.cooked / stats.planned;
}

export function overrunRate(slot: SlotStats): number | null {
  if (slot.withFeedback === 0) return null;
  return slot.tookLonger / slot.withFeedback;
}

/**
 * Planned more than once and never actually cooked. The strongest implicit
 * negative signal in the system, and one a rating never captures because the
 * meal that never happened never gets rated.
 */
export function neverCookedThoughPlanned(
  stats: readonly RecipeStats[],
): RecipeStats[] {
  return stats.filter(
    (row) => row.planned >= NEVER_COOKED_MIN_PLANNED && row.cooked === 0,
  );
}

/**
 * A slot whose budget the data disagrees with. Rounded up to the next five
 * minutes, because a suggestion of "37 minutes" reads as false precision from a
 * handful of observations.
 */
export function budgetSuggestions(
  slots: readonly SlotStats[],
): BudgetSuggestion[] {
  const suggestions: BudgetSuggestion[] = [];

  for (const slot of slots) {
    if (slot.timeBudgetMin === null) continue;
    if (slot.withFeedback < OVERRUN_MIN_OBSERVATIONS) continue;

    const rate = overrunRate(slot);
    if (rate === null || rate < OVERRUN_RATE_THRESHOLD) continue;

    const observed = slot.longestOverrunMin ?? slot.timeBudgetMin;
    const suggested = Math.max(
      slot.timeBudgetMin + 5,
      Math.ceil(observed / 5) * 5,
    );
    if (suggested <= slot.timeBudgetMin) continue;

    suggestions.push({
      dayOfWeek: slot.dayOfWeek,
      mealTypeId: slot.mealTypeId,
      mealTypeLabel: slot.mealTypeLabel,
      currentBudgetMin: slot.timeBudgetMin,
      suggestedBudgetMin: suggested,
      overrunCount: slot.tookLonger,
      observedCount: slot.withFeedback,
    });
  }

  return suggestions;
}

/**
 * The unresolved-signals section of the snapshot: things the data says that
 * nobody has acted on yet. Phrased as observations, never as conclusions.
 */
export function unresolvedSignals(
  recipes: readonly RecipeStats[],
  slots: readonly SlotStats[],
): UnresolvedSignal[] {
  const signals: UnresolvedSignal[] = [];

  for (const recipe of neverCookedThoughPlanned(recipes)) {
    signals.push({
      code: "NEVER_COOKED_THOUGH_PLANNED",
      message: `« ${recipe.title} » a été planifiée ${recipe.planned} fois et n'a jamais été cuisinée.`,
      details: { recipeId: recipe.recipeId, planned: recipe.planned },
    });
  }

  for (const suggestion of budgetSuggestions(slots)) {
    signals.push({
      code: "SLOT_OVERRUNS",
      message: `${suggestion.overrunCount} repas sur ${suggestion.observedCount} ont pris plus de temps que prévu sur ce créneau, dont le budget est de ${suggestion.currentBudgetMin} min.`,
      details: {
        dayOfWeek: suggestion.dayOfWeek,
        mealTypeLabel: suggestion.mealTypeLabel,
        currentBudgetMin: suggestion.currentBudgetMin,
        suggestedBudgetMin: suggestion.suggestedBudgetMin,
      },
    });
  }

  for (const recipe of recipes) {
    if (recipe.averageRating === null) continue;
    if (recipe.averageRating > 2 || recipe.cooked < 2) continue;
    signals.push({
      code: "LOW_RATED_STILL_PLANNED",
      message: `« ${recipe.title} » est notée ${recipe.averageRating.toFixed(1)} sur 5 en moyenne sur ${recipe.cooked} repas, et reste dans la bibliothèque.`,
      details: {
        recipeId: recipe.recipeId,
        averageRating: recipe.averageRating,
        cooked: recipe.cooked,
      },
    });
  }

  return signals;
}
