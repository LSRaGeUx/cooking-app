import type { DomainErrorDetails } from "./errors";

/**
 * Rebuilding a refusal from its code and details, so a screen can word it in
 * the reader's language.
 *
 * Pure, and here rather than next to the React hook that uses it, because it is
 * the other half of the error taxonomy: `errors.ts` says details exist so that
 * "screens render code plus details through next-intl", and this is the
 * function that reads them. Keeping it in the domain means it can be tested
 * against real thrown errors rather than against a fixture of what someone
 * thought the details looked like.
 */

export type MessageParams = Record<string, string | number>;

/**
 * The parameters each template needs, read out of `details`.
 *
 * Returning null means "these details cannot fill this template", which sends
 * the caller back to the server sentence rather than rendering a message with
 * `undefined` in it. That happens when a code is thrown from a site that
 * carries different details, and it must degrade rather than lie.
 */
export function errorMessageParams(
  code: string,
  details: DomainErrorDetails,
  dayName: (day: number) => string,
): MessageParams | null {
  const slot = (): string | null => {
    const day = num(details.dayOfWeek);
    const label = str(details.mealTypeLabel);
    if (day === null || label === null) return str(details.slot);
    return `${dayName(day)} ${label.toLowerCase()}`;
  };

  switch (code) {
    case "STRICT_ALLERGEN": {
      const hits = Array.isArray(details.hits) ? details.hits : [];
      const first = hits[0] as Record<string, unknown> | undefined;
      const recipeTitle = str(details.recipeTitle);
      if (!first || recipeTitle === null) return null;
      return {
        recipeTitle,
        ingredient: str(first.ingredient) ?? "",
        allergen: str(first.allergen) ?? "",
        matchedTerm: str(first.matchedTerm) ?? "",
      };
    }

    case "SLOT_NOT_PLANNED": {
      const label = slot();
      const state = str(details.state);
      if (label === null || state === null) return null;
      return {
        slot: label,
        state,
        available: list(details.available),
        availableCount: count(details.available),
      };
    }

    case "SLOT_UNKNOWN": {
      const day = num(details.dayOfWeek);
      if (day === null) return null;
      return {
        day: dayName(day),
        available: list(details.available),
        availableCount: count(details.available),
      };
    }

    case "TIME_BUDGET_EXCEEDED": {
      const label = slot();
      const budget = num(details.budgetMin);
      const active = num(details.activeTimeMin);
      const over = num(details.overByMin);
      const tolerance = num(details.toleranceMin);
      if (
        label === null ||
        budget === null ||
        active === null ||
        over === null ||
        tolerance === null
      ) {
        return null;
      }
      return { slot: label, budget, active, over, tolerance };
    }

    case "TIME_BUDGET_TIGHT": {
      const label = slot();
      const budget = num(details.budgetMin);
      const active = num(details.activeTimeMin);
      const over = num(details.overByMin);
      if (label === null || budget === null || active === null || over === null) {
        return null;
      }
      return { slot: label, budget, active, over };
    }

    case "VERSION_CONFLICT": {
      const current = num(details.current);
      if (current === null) return null;
      return { expected: num(details.expected) ?? 0, current };
    }

    case "PREP_LINK_ORDER": {
      const source = num(details.sourceDay);
      const dependent = num(details.dependentDay);
      if (source === null || dependent === null) return null;
      return { source: dayName(source), dependent: dayName(dependent) };
    }

    case "MISSING_RATIONALE": {
      const recipeTitle = str(details.recipeTitle);
      const label = str(details.slot);
      if (recipeTitle === null || label === null) return null;
      return { recipeTitle, slot: label };
    }

    case "FACT_CAP_REACHED": {
      const active = num(details.active);
      const cap = num(details.cap);
      if (active === null || cap === null) return null;
      return { active, cap };
    }

    case "MISSING_SCOPE": {
      const missing = list(details.missing);
      if (missing === "") return null;
      return { missing };
    }

    case "CLIENT_REVOKED":
      return {};

    case "RATE_LIMITED": {
      const limit = num(details.limitPerMinute);
      if (limit === null) return null;
      return { limit };
    }

    case "EXCLUDED_INGREDIENT": {
      const kind = str(details.kind);
      const recipeTitle = str(details.recipeTitle);
      const ingredient = str(details.ingredient);
      if (kind === null || recipeTitle === null || ingredient === null) {
        return null;
      }
      return {
        kind,
        recipeTitle,
        ingredient,
        // Whichever of the two the row carries. The template picks by `kind`.
        reason: str(details.allergen) ?? str(details.exclusion) ?? "",
      };
    }

    case "EQUIPMENT_MISSING": {
      const recipeTitle = str(details.recipeTitle);
      if (recipeTitle === null) return null;
      return { recipeTitle, equipment: list(details.missingEquipment) };
    }

    case "REPEAT_RECIPE_THIS_WEEK": {
      const recipeTitle = str(details.recipeTitle);
      const times = num(details.count);
      const variety = num(details.varietyPreference);
      if (recipeTitle === null || times === null || variety === null) {
        return null;
      }
      return { recipeTitle, count: times, variety };
    }

    case "SERVINGS_SHORTFALL": {
      const recipeTitle = str(details.recipeTitle);
      const servings = num(details.sourceServings);
      const drawn = num(details.drawn);
      const required = num(details.required);
      if (
        recipeTitle === null ||
        servings === null ||
        drawn === null ||
        required === null
      ) {
        return null;
      }
      return { recipeTitle, servings, drawn, required };
    }

    case "NOT_BATCH_FRIENDLY": {
      const recipeTitle = str(details.recipeTitle);
      if (recipeTitle === null) return null;
      return { recipeTitle };
    }

    // RECIPE_NOT_FOUND, NOT_FOUND, FORBIDDEN and VALIDATION are thrown from
    // many places with unrelated details, so there is nothing general to say
    // that would beat the sentence the service already wrote.
    default:
      return null;
  }
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function list(value: unknown): string {
  return Array.isArray(value) ? value.map(String).join(", ") : "";
}

function count(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}
