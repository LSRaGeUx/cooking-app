import { describe, expect, it } from "vitest";
import { DomainError } from "@/domain/errors";
import {
  activeTimeOf,
  assertTimeBudget,
  checkTimeBudget,
  resolvePlannableSlot,
  type SlotDefinition,
} from "@/domain/slots";
import { expectDomainErrorSync } from "../helpers";

const dinnerMonday: SlotDefinition = {
  dayOfWeek: 1,
  mealTypeId: "meal-dinner",
  mealTypeKey: "dinner",
  mealTypeLabel: "Dîner",
  state: "planned",
  timeBudgetMin: 30,
  defaultServings: 2,
};

const dinnerFriday: SlotDefinition = {
  ...dinnerMonday,
  dayOfWeek: 5,
  state: "skipped",
};

const slots = [dinnerMonday, dinnerFriday];

/**
 * Monday dinner has a 30-minute budget and a 10-minute tolerance, so 25 minutes
 * is inside, 38 is tight and 75 is refused. Declared here rather than inside the
 * first describe because both `checkTimeBudget` and `assertTimeBudget` are
 * measured against the same three numbers.
 */
const base = {
  slot: dinnerMonday,
  profileDefaultBudgetMin: null,
  toleranceMin: 10,
};

describe("slot resolution", () => {
  it("returns a planned slot", () => {
    expect(
      resolvePlannableSlot(slots, { dayOfWeek: 1, mealTypeId: "meal-dinner" }),
    ).toBe(dinnerMonday);
  });

  it("rejects a skipped slot and lists the planned ones", () => {
    const error = expectDomainErrorSync(
      () =>
        resolvePlannableSlot(slots, {
          dayOfWeek: 5,
          mealTypeId: "meal-dinner",
        }),
      "SLOT_NOT_PLANNED",
    );
    expect(error.details.available).toEqual(["lundi dîner"]);
  });

  it("rejects an unknown slot and lists the planned ones", () => {
    const error = expectDomainErrorSync(
      () =>
        resolvePlannableSlot(slots, { dayOfWeek: 3, mealTypeId: "meal-lunch" }),
      "SLOT_UNKNOWN",
    );
    expect(error.details.available).toEqual(["lundi dîner"]);
  });
});

/**
 * One test per branch of the verdict, because the value is the contract now.
 *
 * `checkTimeBudget` used to return a warning on one outcome and throw on
 * another, so a caller that did not wrap it in a `try` could still have its
 * transaction aborted. Asserting on `kind` is what pins the replacement down:
 * a branch that silently starts returning `within` where it used to return
 * `exceeded` is a strict allergen's worth of quiet failure in the time rules.
 */
describe("time budget verdict", () => {
  it("is `within` inside the budget", () => {
    expect(checkTimeBudget({ ...base, activeTimeMin: 25 })).toEqual({
      kind: "within",
    });
  });

  it("is `tight` inside the tolerance, carrying the warning", () => {
    const verdict = checkTimeBudget({ ...base, activeTimeMin: 38 });
    expect(verdict.kind).toBe("tight");
    if (verdict.kind !== "tight") return;

    expect(verdict.warning.code).toBe("TIME_BUDGET_TIGHT");
    expect(verdict.warning.details).toMatchObject({
      budgetMin: 30,
      activeTimeMin: 38,
      overByMin: 8,
    });
  });

  it("is `exceeded` past the tolerance, naming budget and actual", () => {
    const verdict = checkTimeBudget({ ...base, activeTimeMin: 75 });
    expect(verdict.kind).toBe("exceeded");
    if (verdict.kind !== "exceeded") return;

    // The error is carried, not thrown, and it is ready to throw: a caller that
    // hands it to an agent must find the same code and the same numbers in it
    // as when this rule threw for itself.
    expect(verdict.error).toBeInstanceOf(DomainError);
    expect(verdict.error.code).toBe("TIME_BUDGET_EXCEEDED");
    expect(verdict.error.details).toMatchObject({
      budgetMin: 30,
      activeTimeMin: 75,
      overByMin: 45,
    });
  });

  it("falls back to the profile budget when the slot has none", () => {
    const slot = { ...dinnerMonday, timeBudgetMin: null };
    const verdict = checkTimeBudget({
      slot,
      activeTimeMin: 60,
      profileDefaultBudgetMin: 20,
      toleranceMin: 10,
    });

    expect(verdict.kind).toBe("exceeded");
    if (verdict.kind !== "exceeded") return;
    // The numbers are the evidence that the fallback was read: 20 is the
    // profile's budget, and 40 is what a 60-minute recipe is over it by.
    expect(verdict.error.details).toMatchObject({
      budgetMin: 20,
      overByMin: 40,
    });
  });

  it("is `within` when either the budget or the active time is unknown", () => {
    // No budget anywhere: 90 minutes cannot be over a limit nobody set.
    expect(
      checkTimeBudget({
        slot: { ...dinnerMonday, timeBudgetMin: null },
        activeTimeMin: 90,
        profileDefaultBudgetMin: null,
        toleranceMin: 10,
      }),
    ).toEqual({ kind: "within" });

    // A budget but no attended time, which is the recipe typed in a hurry.
    // Guessing at it here is what would put a false refusal in front of a cook.
    expect(checkTimeBudget({ ...base, activeTimeMin: null })).toEqual({
      kind: "within",
    });
  });
});

/**
 * The mixed contract, kept for the caller that wants to be aborted. It is the
 * half of the split that can regress silently: nothing in the type system says
 * a function returning `DomainWarning | null` also throws, so the throw is
 * asserted here rather than assumed at every assignment site.
 */
describe("assertTimeBudget", () => {
  it("throws the exceeded error", () => {
    const error = expectDomainErrorSync(
      () => assertTimeBudget({ ...base, activeTimeMin: 75 }),
      "TIME_BUDGET_EXCEEDED",
    );
    expect(error.details).toMatchObject({ overByMin: 45 });
  });

  it("returns the warning inside the tolerance", () => {
    const warning = assertTimeBudget({ ...base, activeTimeMin: 38 });
    expect(warning?.code).toBe("TIME_BUDGET_TIGHT");
    expect(warning?.details?.overByMin).toBe(8);
  });

  it("returns null inside the budget", () => {
    expect(assertTimeBudget({ ...base, activeTimeMin: 25 })).toBeNull();
  });
});

describe("active time", () => {
  it("prefers the recorded attended time", () => {
    expect(
      activeTimeOf({ activeTimeMin: 15, prepTimeMin: 10, cookTimeMin: 50 }),
    ).toBe(15);
  });

  it("falls back to prep plus cook when it was never filled in", () => {
    expect(
      activeTimeOf({ activeTimeMin: null, prepTimeMin: 10, cookTimeMin: 50 }),
    ).toBe(60);
  });

  it("stays unknown when the recipe carries no times at all", () => {
    expect(
      activeTimeOf({
        activeTimeMin: null,
        prepTimeMin: null,
        cookTimeMin: null,
      }),
    ).toBeNull();
  });
});
