import { DomainError, type DomainWarning } from "./errors";
import { dayName } from "./slots";

/**
 * The rules for batch cooking.
 *
 * One is a hard error and the rest are warnings, and the split is deliberate.
 * Eating on Tuesday what you cook on Thursday is impossible, so it is refused.
 * Stretching four portions across five meals is merely optimistic, and people
 * do it knowingly, so it is flagged and allowed.
 */

export interface PrepEndpoint {
  readonly entryId: string;
  readonly dayOfWeek: number;
  readonly mealTypeLabel: string;
  readonly recipeTitle: string;
  readonly servings: number;
  readonly batchFriendly: boolean;
}

/**
 * The cooking session has to happen first. Same day is allowed: cooking a big
 * lunch and eating the rest at dinner is the most common case of all.
 */
export function assertPrepOrder(
  source: PrepEndpoint,
  dependent: PrepEndpoint,
): void {
  if (source.dayOfWeek <= dependent.dayOfWeek) return;

  throw new DomainError(
    "PREP_LINK_ORDER",
    `Vous ne pouvez pas servir ${dayName(dependent.dayOfWeek)} un plat cuisiné ${dayName(source.dayOfWeek)}. La session de cuisine doit venir le même jour ou avant. Inversez les deux créneaux, ou choisissez une autre source.`,
    {
      sourceDay: source.dayOfWeek,
      dependentDay: dependent.dayOfWeek,
    },
  );
}

export interface PrepDraw {
  readonly dependent: PrepEndpoint;
  readonly servingsDrawn: number;
}

/**
 * What a cooking session owes: its own meal plus everything drawn from it.
 * A shortfall is a warning because a user may knowingly stretch a dish, and
 * refusing would make the feature useless for exactly the people who use it.
 */
export function checkPrepCapacity(
  source: PrepEndpoint,
  draws: readonly PrepDraw[],
): DomainWarning | null {
  const drawn = draws.reduce((total, draw) => total + draw.servingsDrawn, 0);
  const required = source.servings + drawn;

  if (drawn === 0 || required <= source.servings) return null;

  // The source's own servings have to cover both its meal and the draws, so a
  // shortfall is any case where the draws eat into its own portions.
  const shortfall = drawn;
  if (shortfall <= 0) return null;

  return {
    code: "SERVINGS_SHORTFALL",
    message: `« ${source.recipeTitle} » est prévu pour ${source.servings} portions, et ${drawn} de plus sont tirées pour d'autres repas. Prévoyez ${required} portions au total, ou réduisez ce qui est tiré.`,
    details: {
      sourceServings: source.servings,
      drawn,
      required,
    },
  };
}

/** A dish that does not keep is a poor choice of cooking session. */
export function checkBatchFriendly(source: PrepEndpoint): DomainWarning | null {
  if (source.batchFriendly) return null;
  return {
    code: "NOT_BATCH_FRIENDLY",
    message: `« ${source.recipeTitle} » n'est pas marquée comme se doublant et se conservant bien. Elle peut quand même servir de session de cuisine, mais vérifiez qu'elle tient jusqu'au repas qui en dépend.`,
    details: { recipeTitle: source.recipeTitle },
  };
}

/**
 * How many servings a cooking session must actually produce, which is what the
 * grocery list scales its ingredients to. A dependent meal contributes nothing
 * of its own: its ingredients were bought once, with the source.
 */
export function totalServingsFor(
  source: { servings: number },
  draws: readonly { servingsDrawn: number }[],
): number {
  return (
    source.servings + draws.reduce((total, draw) => total + draw.servingsDrawn, 0)
  );
}
