import { DomainError, type DomainWarning } from "./errors";
import type { IsoDay } from "./week";

/**
 * Slot rules. A slot is one plannable (day, meal) position, and which slots
 * exist is per-user configuration rather than a fixed grid.
 *
 * The two rules here are the ones an agent hits constantly, so both errors name
 * the valid alternatives: being rejected by a rule you cannot see is the worst
 * possible agent experience (docs/03-agent-interface.md section 1).
 */

export type SlotState = "planned" | "skipped" | "hidden";

export interface SlotDefinition {
  readonly dayOfWeek: IsoDay;
  readonly mealTypeId: string;
  readonly mealTypeKey: string;
  readonly mealTypeLabel: string;
  readonly state: SlotState;
  readonly timeBudgetMin: number | null;
  readonly defaultServings: number | null;
}

export interface SlotRef {
  readonly dayOfWeek: number;
  readonly mealTypeId: string;
}

/** Monday-first French day names, used in agent-facing messages only. */
const DAY_NAMES = [
  "lundi",
  "mardi",
  "mercredi",
  "jeudi",
  "vendredi",
  "samedi",
  "dimanche",
] as const;

export function dayName(dayOfWeek: number): string {
  return DAY_NAMES[dayOfWeek - 1] ?? `jour ${dayOfWeek}`;
}

export function describeSlot(slot: SlotDefinition): string {
  return `${dayName(slot.dayOfWeek)} ${slot.mealTypeLabel.toLowerCase()}`;
}

export function findSlot(
  slots: readonly SlotDefinition[],
  ref: SlotRef,
): SlotDefinition | undefined {
  return slots.find(
    (slot) =>
      slot.dayOfWeek === ref.dayOfWeek && slot.mealTypeId === ref.mealTypeId,
  );
}

export function plannableSlots(
  slots: readonly SlotDefinition[],
): SlotDefinition[] {
  return slots.filter((slot) => slot.state === "planned");
}

/**
 * Resolves a slot reference or throws. Both failure modes list the slots the
 * caller could have used instead, which is what turns a rejection into a
 * successful retry.
 */
export function resolvePlannableSlot(
  slots: readonly SlotDefinition[],
  ref: SlotRef,
): SlotDefinition {
  const slot = findSlot(slots, ref);
  const available = plannableSlots(slots).map(describeSlot);

  if (!slot) {
    throw new DomainError(
      "SLOT_UNKNOWN",
      `Aucun créneau ${dayName(ref.dayOfWeek)} ne correspond à ce type de repas dans votre configuration. Créneaux planifiables : ${available.join(", ") || "aucun"}.`,
      {
        dayOfWeek: ref.dayOfWeek,
        mealTypeId: ref.mealTypeId,
        available,
        availableCount: available.length,
      },
    );
  }

  if (slot.state !== "planned") {
    throw new DomainError(
      "SLOT_NOT_PLANNED",
      `Le créneau ${describeSlot(slot)} est configuré comme « ${slot.state === "skipped" ? "sauté" : "masqué"} » et ne doit pas être rempli. Créneaux planifiables : ${available.join(", ") || "aucun"}.`,
      {
        // `slot` is the French label an agent reads. The screen needs the parts
        // instead, because it words the same rule in the reader's language and
        // cannot translate a sentence that arrived pre-assembled.
        slot: describeSlot(slot),
        dayOfWeek: slot.dayOfWeek,
        mealTypeLabel: slot.mealTypeLabel,
        state: slot.state,
        available,
        availableCount: available.length,
      },
    );
  }

  return slot;
}

export interface TimeBudgetCheck {
  /** Attended minutes the recipe needs. Unattended oven time does not count. */
  readonly activeTimeMin: number | null;
  readonly slot: SlotDefinition;
  /** Fallback when the slot itself carries no budget. */
  readonly profileDefaultBudgetMin: number | null;
  readonly toleranceMin: number;
}

/**
 * Over budget but inside the tolerance is a warning the user can accept; past
 * the tolerance it is a rejection. That asymmetry is the whole point of storing
 * a tolerance: a 20-minute budget missed by 3 minutes is not worth blocking a
 * week over, and missed by 40 minutes is not a plan the user can cook.
 */
export function checkTimeBudget({
  activeTimeMin,
  slot,
  profileDefaultBudgetMin,
  toleranceMin,
}: TimeBudgetCheck): DomainWarning | null {
  const budget = slot.timeBudgetMin ?? profileDefaultBudgetMin;
  if (budget === null || activeTimeMin === null) return null;
  if (activeTimeMin <= budget) return null;

  const over = activeTimeMin - budget;
  const label = describeSlot(slot);

  if (over > toleranceMin) {
    throw new DomainError(
      "TIME_BUDGET_EXCEEDED",
      `${label} a un budget de ${budget} min de cuisine active, et cette recette en demande ${activeTimeMin} min, soit ${over} min de trop (tolérance : ${toleranceMin} min). Choisissez une recette plus rapide, augmentez le budget de ce créneau, ou cuisinez-la en avance depuis un autre créneau.`,
      {
        slot: label,
        dayOfWeek: slot.dayOfWeek,
        mealTypeLabel: slot.mealTypeLabel,
        budgetMin: budget,
        activeTimeMin,
        overByMin: over,
        toleranceMin,
      },
    );
  }

  return {
    code: "TIME_BUDGET_TIGHT",
    message: `${label} dépasse son budget de ${over} min (${activeTimeMin} min pour un budget de ${budget} min), ce qui reste dans la tolérance.`,
    details: {
      slot: label,
      dayOfWeek: slot.dayOfWeek,
      mealTypeLabel: slot.mealTypeLabel,
      budgetMin: budget,
      activeTimeMin,
      overByMin: over,
    },
  };
}

/**
 * Attended minutes for a recipe. Falls back to prep plus cook when the recipe
 * never had an active time filled in, which is the common case for a recipe
 * typed in a hurry.
 */
export function activeTimeOf(recipe: {
  activeTimeMin: number | null;
  prepTimeMin: number | null;
  cookTimeMin: number | null;
}): number | null {
  if (recipe.activeTimeMin !== null) return recipe.activeTimeMin;
  if (recipe.prepTimeMin === null && recipe.cookTimeMin === null) return null;
  return (recipe.prepTimeMin ?? 0) + (recipe.cookTimeMin ?? 0);
}
