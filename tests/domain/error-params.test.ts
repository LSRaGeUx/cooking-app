import { IntlMessageFormat } from "intl-messageformat";
import { describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import fr from "../../messages/fr.json";
import { assertNoStrictAllergen } from "@/domain/allergens";
import { errorMessageParams } from "@/domain/error-params";
import { DomainError } from "@/domain/errors";
import { assertPrepOrder } from "@/domain/prep";
import { assertTimeBudget, resolvePlannableSlot } from "@/domain/slots";

/**
 * The coupling this file exists to protect.
 *
 * A screen words a refusal from its code and its details, because the sentence
 * the service wrote is French and is meant for the agent. That works only while
 * the details a rule actually throws still carry what its template names. Drop
 * a field from a `details` object and nothing breaks loudly: the message quietly
 * falls back to French in an English page, which is exactly the bug Q9 was
 * about.
 *
 * So every case here throws the real error through the real rule, then renders
 * both catalogues with the parameters that came out.
 *
 * The time budget goes through `assertTimeBudget` rather than
 * `checkTimeBudget`, which now returns its verdict instead of throwing it. The
 * throwing wrapper is what a screen is downstream of, and keeping every case in
 * this file shaped the same way is what makes a missing template obvious. Which
 * branch of the verdict carries what is pinned in tests/domain/slots.test.ts.
 */

const days: Record<string, string> = {
  "1": "lundi",
  "2": "mardi",
  "3": "mercredi",
  "4": "jeudi",
  "5": "vendredi",
  "6": "samedi",
  "7": "dimanche",
};

const dayName = (day: number): string => days[String(day)] ?? String(day);

function template(
  catalogue: Record<string, unknown>,
  group: "errors" | "warnings",
  code: string,
): string {
  const messages = (catalogue[group] as Record<string, unknown>).messages as
    | Record<string, string>
    | undefined;
  const found = messages?.[code];
  expect(found, `no ${group}.messages.${code} template`).toBeTypeOf("string");
  return found as string;
}

/** Renders both catalogues, and returns the French one for assertions. */
function render(
  group: "errors" | "warnings",
  code: string,
  details: Record<string, unknown>,
): string {
  const params = errorMessageParams(code, details, dayName);
  expect(params, `${code} details do not fill its template`).not.toBeNull();

  const rendered = (["fr", "en"] as const).map((locale) => {
    const catalogue = locale === "fr" ? fr : en;
    const message = new IntlMessageFormat(
      template(catalogue, group, code),
      locale,
    );
    return String(message.format(params ?? {}));
  });

  // Neither language may leave a placeholder unfilled.
  for (const text of rendered) expect(text).not.toMatch(/\{[a-zA-Z]/);
  return rendered[0]!;
}

function caught(fn: () => void): DomainError {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error("expected the rule to refuse");
}

const dinner = {
  dayOfWeek: 2 as const,
  mealTypeId: "meal-dinner",
  mealTypeKey: "dinner",
  mealTypeLabel: "Dîner",
  state: "planned" as const,
  timeBudgetMin: 20,
  defaultServings: 2,
};

describe("refusals a screen has to reword", () => {
  it("a strict allergen names the recipe, the ingredient and the term", () => {
    const error = caught(() =>
      assertNoStrictAllergen(
        "Quiche lorraine",
        [{ rawName: "lardons" }],
        [
          {
            id: "a1",
            name: "porc",
            severity: "strict",
            matches: ["lardons"],
          },
        ],
      ),
    );

    const text = render("errors", error.code, error.details);
    expect(text).toContain("Quiche lorraine");
    expect(text).toContain("lardons");
    expect(text).toContain("porc");
  });

  it("a skipped slot names the slot, its state and the alternatives", () => {
    const error = caught(() =>
      resolvePlannableSlot(
        [
          { ...dinner, state: "skipped" },
          { ...dinner, dayOfWeek: 3, mealTypeLabel: "Dîner" },
        ],
        { dayOfWeek: 2, mealTypeId: "meal-dinner" },
      ),
    );

    const text = render("errors", error.code, error.details);
    expect(error.code).toBe("SLOT_NOT_PLANNED");
    expect(text).toContain("mardi dîner");
    expect(text).toContain("sauté");
    // The alternatives are the whole point of this refusal.
    expect(text).toContain("mercredi dîner");
  });

  it("an unknown slot names the day and the alternatives", () => {
    const error = caught(() =>
      resolvePlannableSlot([dinner], {
        dayOfWeek: 5,
        mealTypeId: "meal-lunch",
      }),
    );

    const text = render("errors", error.code, error.details);
    expect(error.code).toBe("SLOT_UNKNOWN");
    expect(text).toContain("vendredi");
    expect(text).toContain("mardi dîner");
  });

  it("an empty alternative list reads as a sentence, not a dangling colon", () => {
    const error = caught(() =>
      resolvePlannableSlot([{ ...dinner, state: "hidden" }], {
        dayOfWeek: 2,
        mealTypeId: "meal-dinner",
      }),
    );

    const text = render("errors", error.code, error.details);
    expect(text).toContain("Aucun créneau n'est planifiable.");
    expect(text).not.toContain(": .");
  });

  it("a blown time budget names every number the cook needs", () => {
    const error = caught(() =>
      assertTimeBudget({
        activeTimeMin: 75,
        slot: dinner,
        profileDefaultBudgetMin: null,
        toleranceMin: 10,
      }),
    );

    const text = render("errors", error.code, error.details);
    expect(error.code).toBe("TIME_BUDGET_EXCEEDED");
    expect(text).toContain("mardi dîner");
    expect(text).toContain("20 min");
    expect(text).toContain("75 min");
    expect(text).toContain("55 min");
  });

  it("an impossible prep order names both days", () => {
    const error = caught(() =>
      assertPrepOrder(
        {
          entryId: "e1",
          dayOfWeek: 5,
          mealTypeLabel: "Dîner",
          recipeTitle: "Chili",
          servings: 4,
          batchFriendly: true,
        },
        {
          entryId: "e2",
          dayOfWeek: 2,
          mealTypeLabel: "Dîner",
          recipeTitle: "Chili",
          servings: 2,
          batchFriendly: true,
        },
      ),
    );

    const text = render("errors", error.code, error.details);
    expect(text).toContain("mardi");
    expect(text).toContain("vendredi");
  });
});

describe("warnings a screen has to reword", () => {
  it("a tight time budget stays a warning and still names the slot", () => {
    const warning = assertTimeBudget({
      activeTimeMin: 25,
      slot: dinner,
      profileDefaultBudgetMin: null,
      toleranceMin: 10,
    });

    // Five minutes over a 20-minute budget, inside a 10-minute tolerance: the
    // rule must hand back a warning rather than refuse and rather than say
    // nothing at all.
    expect(warning?.code).toBe("TIME_BUDGET_TIGHT");
    if (!warning) return;

    const text = render("warnings", warning.code, warning.details ?? {});
    expect(text).toContain("mardi dîner");
    expect(text).toContain("5 min");
  });
});

describe("degrading instead of lying", () => {
  it("falls back when the details cannot fill the template", () => {
    // A code thrown from a site that carries unrelated details must not render
    // a sentence with holes in it.
    expect(errorMessageParams("TIME_BUDGET_EXCEEDED", {}, dayName)).toBeNull();
    expect(errorMessageParams("STRICT_ALLERGEN", {}, dayName)).toBeNull();
  });

  it("has nothing to say about the codes thrown from everywhere", () => {
    // VALIDATION, NOT_FOUND and FORBIDDEN cover dozens of unrelated rules, so
    // the sentence the service wrote is better than anything generic.
    for (const code of ["VALIDATION", "NOT_FOUND", "FORBIDDEN"]) {
      expect(errorMessageParams(code, { anything: 1 }, dayName)).toBeNull();
    }
  });
});
