import { DomainError, type DomainWarning } from "./errors";
import { dayName } from "./slots";
import type { IsoDay } from "./week";

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
 * Whether a session cooked on `sourceDay` can feed a meal on `dependentDay`.
 *
 * The whole of the `PREP_LINK_ORDER` rule, in one predicate, so the screen that
 * offers the candidate sources and the service that refuses a bad link cannot
 * disagree about which days qualify. The week grid used to re-implement the
 * comparison inline, which meant the list of candidates and the rule that
 * rejects them were two statements of the same thing.
 *
 * Same day is allowed: cooking a big lunch and eating the rest at dinner is the
 * most common case of all.
 */
export function canServeFrom(sourceDay: IsoDay, dependentDay: IsoDay): boolean {
  return servesInOrder(sourceDay, dependentDay);
}

/**
 * The comparison itself, on plain numbers, because a plan entry's day comes
 * back from the database as one. `canServeFrom` is the narrowed public door and
 * `assertPrepOrder` the throwing one, and both read the rule from here.
 */
function servesInOrder(sourceDay: number, dependentDay: number): boolean {
  return sourceDay <= dependentDay;
}

/**
 * The cooking session has to happen first. Same day is allowed: cooking a big
 * lunch and eating the rest at dinner is the most common case of all.
 */
export function assertPrepOrder(
  source: PrepEndpoint,
  dependent: PrepEndpoint,
): void {
  if (servesInOrder(source.dayOfWeek, dependent.dayOfWeek)) return;

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
 * What a cooking session owes, and whether anything is actually short.
 *
 * **The model: `entry.servings` is the meal, not the batch.** A source entry's
 * servings count covers its own meal and nothing else, and the draws are added
 * on top. `totalServingsFor` below is that sum, and the grocery list scales the
 * source recipe by it, so the ingredients for every drawn portion are bought.
 *
 * That is why there is nothing to warn about here in the ordinary case, and why
 * this used to be wrong. It computed `source.servings + drawn` and then warned
 * whenever `drawn > 0`, which is every prep link there has ever been. The
 * sentence told the user to raise the source's servings to a total the grocery
 * list had already shopped for, and doing as it asked would have doubled the
 * draws into the basket. The two branches after it were unreachable, because
 * `required <= source.servings` and `shortfall <= 0` are both impossible once
 * `drawn > 0` and `servingsDrawn` is at least 1.
 *
 * A real shortfall is still possible and still only a warning, because a user
 * may knowingly stretch a dish: a recipe that does not scale (one tin, one
 * mould, one pan) cannot honour an arbitrary total. Nothing in the model
 * records a maximum yield yet, so nothing can detect that, and inventing a
 * threshold would put the false warning straight back. The function is kept as
 * the single place that decision belongs, with a `keepsDays` or maximum-yield
 * check as the shape it will take.
 */
export function checkPrepCapacity(
  _source: PrepEndpoint,
  _draws: readonly PrepDraw[],
): DomainWarning | null {
  return null;
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
    source.servings +
    draws.reduce((total, draw) => total + draw.servingsDrawn, 0)
  );
}
