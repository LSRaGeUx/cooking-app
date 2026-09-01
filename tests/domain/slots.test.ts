import { describe, expect, it } from "vitest";
import { DomainError } from "@/domain/errors";
import {
  activeTimeOf,
  checkTimeBudget,
  resolvePlannableSlot,
  type SlotDefinition,
} from "@/domain/slots";

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

describe("slot resolution", () => {
  it("returns a planned slot", () => {
    expect(
      resolvePlannableSlot(slots, { dayOfWeek: 1, mealTypeId: "meal-dinner" }),
    ).toBe(dinnerMonday);
  });

  it("rejects a skipped slot and lists the planned ones", () => {
    let thrown: unknown;
    try {
      resolvePlannableSlot(slots, { dayOfWeek: 5, mealTypeId: "meal-dinner" });
    } catch (error) {
      thrown = error;
    }

    const error = thrown as DomainError;
    expect(error.code).toBe("SLOT_NOT_PLANNED");
    expect(error.details.available).toEqual(["lundi dîner"]);
  });

  it("rejects an unknown slot and lists the planned ones", () => {
    let thrown: unknown;
    try {
      resolvePlannableSlot(slots, { dayOfWeek: 3, mealTypeId: "meal-lunch" });
    } catch (error) {
      thrown = error;
    }

    const error = thrown as DomainError;
    expect(error.code).toBe("SLOT_UNKNOWN");
    expect(error.details.available).toEqual(["lundi dîner"]);
  });
});

describe("time budget", () => {
  const base = {
    slot: dinnerMonday,
    profileDefaultBudgetMin: null,
    toleranceMin: 10,
  };

  it("passes inside the budget", () => {
    expect(checkTimeBudget({ ...base, activeTimeMin: 25 })).toBeNull();
  });

  it("warns inside the tolerance", () => {
    const warning = checkTimeBudget({ ...base, activeTimeMin: 38 });
    expect(warning?.code).toBe("TIME_BUDGET_TIGHT");
    expect(warning?.details?.overByMin).toBe(8);
  });

  it("blocks past the tolerance, naming budget and actual", () => {
    let thrown: unknown;
    try {
      checkTimeBudget({ ...base, activeTimeMin: 75 });
    } catch (error) {
      thrown = error;
    }

    const error = thrown as DomainError;
    expect(error.code).toBe("TIME_BUDGET_EXCEEDED");
    expect(error.details).toMatchObject({
      budgetMin: 30,
      activeTimeMin: 75,
      overByMin: 45,
    });
  });

  it("falls back to the profile budget when the slot has none", () => {
    const slot = { ...dinnerMonday, timeBudgetMin: null };
    expect(() =>
      checkTimeBudget({
        slot,
        activeTimeMin: 60,
        profileDefaultBudgetMin: 20,
        toleranceMin: 10,
      }),
    ).toThrow(DomainError);
  });

  it("does nothing when neither a budget nor an active time is known", () => {
    const slot = { ...dinnerMonday, timeBudgetMin: null };
    expect(
      checkTimeBudget({
        slot,
        activeTimeMin: 90,
        profileDefaultBudgetMin: null,
        toleranceMin: 10,
      }),
    ).toBeNull();
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
      activeTimeOf({ activeTimeMin: null, prepTimeMin: null, cookTimeMin: null }),
    ).toBeNull();
  });
});
