import type { DomainWarning } from "@/domain/errors";
import type { BudgetSuggestion, UnresolvedSignal } from "@/domain/signals";
import type { SlotDefinition } from "@/domain/slots";
import type { HistoryWeek } from "@/services/history-service";
import type { PantryItemView } from "@/services/pantry-service";
import type { PlanEntryView, PlanVersionView } from "@/services/plan-service";
import type {
  RecipeDetail,
  RecipeIndexEntry,
  RecipeRow,
} from "@/services/recipe-service";

/**
 * One shape per entity on the agent surface, used by the tools AND by the
 * resources.
 *
 * Before this file the two halves serialized independently: a tool curated a
 * snake_case view while the matching resource handed back the raw service row.
 * That is two problems in one. Every entity had two shapes an agent had to
 * learn, and the resource half leaked internals it was never meant to publish:
 * `cooking://recipes/{id}` returned the whole `RecipeDetail`, whose row carries
 * `userId`, `sourceClientId` and `allergenIds`, and `cooking://plan/*` dropped
 * the entry `id` that `link_prep` needs, so a week read through the resource
 * could not be linked. Both are structural, so the fix is structural: there is
 * one function per entity and nothing else may serialize one.
 *
 * Two rules hold for everything here:
 *
 * 1. **No internal identifier ever leaves.** `userId` is the tenancy key and
 *    means nothing to an agent, `sourceClientId` is another client's identity,
 *    and `allergenIds` are rows an agent cannot resolve. Timestamps are left out
 *    of a recipe for the same reason the index leaves them out: they cost tokens
 *    and steer nothing.
 * 2. **Field names are snake_case,** as the whole surface now is. See
 *    src/mcp/schemas.ts for the parameter half of that decision.
 */

/**
 * Compact JSON, everywhere.
 *
 * Every one of the two dozen tool and resource outputs used to be
 * `JSON.stringify(x, null, 2)`, on a surface whose own resource descriptions
 * argue for token thrift. Pretty-printing a 200-recipe index spends a third of
 * its bytes on indentation that no model reads, and the receiving end is a JSON
 * parser rather than a human, so there is nothing to trade off.
 */
export function toolJson(value: unknown): string {
  return JSON.stringify(value);
}

export function serializeRecipe(detail: RecipeDetail) {
  return {
    id: detail.recipe.id,
    title: detail.recipe.title,
    description: detail.recipe.description,
    servings: detail.recipe.servings,
    prep_time_min: detail.recipe.prepTimeMin,
    cook_time_min: detail.recipe.cookTimeMin,
    active_time_min: detail.recipe.activeTimeMin,
    batch_friendly: detail.recipe.batchFriendly,
    keeps_days: detail.recipe.keepsDays,
    tags: detail.recipe.tags,
    cuisine: detail.recipe.cuisine,
    main_protein: detail.recipe.mainProtein,
    difficulty: detail.recipe.difficulty,
    equipment_keys: detail.recipe.equipmentKeys,
    // Provenance an agent can act on: an imported recipe is worth re-reading at
    // the source, an agent-written one is its own to correct. The client id
    // behind `source` is deliberately not published.
    source: detail.recipe.source,
    source_url: detail.recipe.sourceUrl,
    revision: detail.recipe.revision,
    // A soft-deleted recipe is still readable so history stays explicable, but
    // it must not be proposed.
    deleted: detail.recipe.deletedAt !== null,
    ingredients: detail.ingredients.map((line) => ({
      quantity: line.quantity,
      unit: line.unit,
      name: line.rawName,
      normalized_name: line.canonicalName,
      note: line.note,
      optional: line.optional,
    })),
    steps: detail.steps.map((step) => ({
      text: step.text,
      duration_min: step.durationMin,
      unattended: step.unattended,
    })),
  };
}

/**
 * One line of a result list. `searchRecipes` answers with whole `RecipeRow`s,
 * tenancy key included, so something has to narrow them and it may as well be
 * the one place that decides what a recipe looks like to an agent.
 */
export function serializeRecipeListing(row: RecipeRow) {
  return {
    id: row.id,
    title: row.title,
    servings: row.servings,
    active_time_min: row.activeTimeMin,
    tags: row.tags,
    main_protein: row.mainProtein,
    cuisine: row.cuisine,
    batch_friendly: row.batchFriendly,
  };
}

/** The compact library line. `cooking://recipes/index` is the only caller. */
export function serializeRecipeIndexEntry(row: RecipeIndexEntry) {
  return {
    id: row.id,
    title: row.title,
    active_time_min: row.activeTimeMin,
    servings: row.servings,
    tags: row.tags,
    main_protein: row.mainProtein,
    cuisine: row.cuisine,
    batch_friendly: row.batchFriendly,
    times_planned: row.timesPlanned,
    times_cooked: row.timesCooked,
    average_rating: row.averageRating,
    weeks_since_last_planned: row.weeksSinceLastPlanned,
    weeks_since_last_cooked: row.weeksSinceLastCooked,
  };
}

export function serializeSlot(slot: SlotDefinition) {
  return {
    day_of_week: slot.dayOfWeek,
    meal_type_id: slot.mealTypeId,
    meal_type_key: slot.mealTypeKey,
    meal_type_label: slot.mealTypeLabel,
    state: slot.state,
    time_budget_min: slot.timeBudgetMin,
    default_servings: slot.defaultServings,
  };
}

/**
 * Always with `id`. `link_prep` names the two meals it relates by entry id, so
 * an entry serialized without one is an entry an agent cannot then link, which
 * is exactly what the plan resources used to hand back.
 */
export function serializeEntry(entry: PlanEntryView) {
  return {
    id: entry.id,
    day_of_week: entry.dayOfWeek,
    meal_type_id: entry.mealTypeId,
    recipe_id: entry.recipeId,
    recipe_title: entry.recipeTitleSnapshot,
    servings: entry.servings,
    note: entry.note,
    rationale: entry.rationale,
    rationale_refs: entry.rationaleRefs ?? [],
  };
}

export function serializePlanVersion(version: PlanVersionView) {
  return {
    number: version.versionNumber,
    state: version.state,
    created_by: version.createdBy,
    summary: version.summary,
  };
}

export function serializePantryItem(item: PantryItemView) {
  return {
    id: item.id,
    name: item.name,
    quantity_note: item.quantityNote,
    expires_on: item.expiresOn,
    source: item.source,
  };
}

export function serializeHistoryWeek(week: HistoryWeek) {
  return {
    year: week.year,
    week: week.week,
    meals: week.entries.map((entry) => ({
      day_of_week: entry.dayOfWeek,
      recipe_title: entry.recipeTitle,
      servings: entry.servings,
      outcome: entry.outcome,
      rating: entry.rating,
      swapped_for: entry.swappedFor,
      took_longer: entry.tookLonger,
      note: entry.note,
    })),
  };
}

export function serializeSignal(signal: UnresolvedSignal) {
  return {
    code: signal.code,
    message: signal.message,
    details: signal.details,
  };
}

export function serializeBudgetSuggestion(suggestion: BudgetSuggestion) {
  return {
    day_of_week: suggestion.dayOfWeek,
    meal_type_label: suggestion.mealTypeLabel,
    current_budget_min: suggestion.currentBudgetMin,
    suggested_budget_min: suggestion.suggestedBudgetMin,
    overruns: `${suggestion.overrunCount}/${suggestion.observedCount}`,
  };
}

/**
 * A warning keeps its `details`, exactly as an error does.
 *
 * Four tools used to return warnings as `{ code, message }` and drop the bag,
 * while `check_feasibility` kept it on the errors beside them. The details are
 * where the correctable parts are: which slot overran, by how many minutes,
 * which ingredient matched. A warning stripped of them tells an agent something
 * is wrong and nothing about what to change, which is the failure mode the whole
 * error taxonomy exists to avoid.
 */
export function serializeWarning(warning: DomainWarning) {
  return {
    code: warning.code,
    message: warning.message,
    details: warning.details ?? {},
  };
}
