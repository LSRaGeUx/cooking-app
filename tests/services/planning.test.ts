import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DomainError } from "@/domain/errors";
import { createAllergen } from "@/services/profile-service";
import { ensureUserSetup } from "@/services/onboarding-service";
import {
  assignRecipe,
  clearEntry,
  duplicateEntry,
  getWeekView,
  listVersions,
  moveEntry,
  revertToVersion,
  updateEntry,
} from "@/services/plan-service";
import { createRecipe } from "@/services/recipe-service";
import { listMealTypes, setSlotConfig } from "@/services/slot-service";
import { cleanupUser, testUser } from "../helpers/fixtures";

/**
 * The rules this file pins down are the ones the whole product rests on:
 * versions are immutable, a strict allergen is never placeable, and a slot the
 * user marked as skipped is never filled. Each test uses its own ISO week,
 * because a write validates the entire resulting week and an allergen added by
 * one test would otherwise block the next one.
 */

const ctx = testUser();
let dinnerId = "";
let lunchId = "";

const quickRecipe = {
  title: "Omelette",
  servings: 2,
  activeTimeMin: 10,
  ingredients: [{ rawName: "3 oeufs" }, { rawName: "sel" }],
  steps: [{ text: "Battre les oeufs." }],
};

const creamyRecipe = {
  title: "Gratin dauphinois",
  servings: 4,
  activeTimeMin: 25,
  ingredients: [{ rawName: "500 ml de crème fraîche" }, { rawName: "1 kg de pommes de terre" }],
  steps: [{ text: "Enfourner." }],
};

const longRecipe = {
  title: "Pot-au-feu",
  servings: 6,
  activeTimeMin: 90,
  ingredients: [{ rawName: "1 kg de carottes" }],
  steps: [{ text: "Laisser mijoter." }],
};

let quickId = "";
let creamyId = "";
let longId = "";

function week(number: number) {
  return { year: 2026, week: number };
}

beforeAll(async () => {
  await ensureUserSetup(ctx);
  const mealTypes = await listMealTypes(ctx);
  dinnerId = mealTypes.find((type) => type.key === "dinner")!.id;
  lunchId = mealTypes.find((type) => type.key === "lunch")!.id;

  quickId = (await createRecipe(ctx, quickRecipe)).recipe.id;
  creamyId = (await createRecipe(ctx, creamyRecipe)).recipe.id;
  longId = (await createRecipe(ctx, longRecipe)).recipe.id;
});

afterAll(async () => {
  await cleanupUser(ctx);
});

describe("an unplanned week", () => {
  it("is plannable without creating a plan", async () => {
    const view = await getWeekView(ctx, week(2));
    expect(view.planId).toBeNull();
    expect(view.activeVersion).toBeNull();
    expect(view.entries).toEqual([]);
    // The seeded grid: dinner planned every day.
    expect(view.slots.filter((slot) => slot.state === "planned")).toHaveLength(7);
  });
});

describe("assigning a recipe", () => {
  const target = week(3);

  it("creates version 1 and activates it", async () => {
    const result = await assignRecipe(ctx, target, {
      dayOfWeek: 1,
      mealTypeId: dinnerId,
      recipeId: quickId,
    });

    expect(result.version.versionNumber).toBe(1);
    expect(result.version.state).toBe("active");
    expect(result.version.createdBy).toBe("user");
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      dayOfWeek: 1,
      recipeTitleSnapshot: "Omelette",
      // Servings fall back to the profile default when neither the call nor the
      // slot says otherwise.
      servings: 2,
    });
  });

  it("writes a new version on the next edit and supersedes the previous one", async () => {
    const result = await assignRecipe(ctx, target, {
      dayOfWeek: 2,
      mealTypeId: dinnerId,
      recipeId: creamyId,
    });

    expect(result.version.versionNumber).toBe(2);
    expect(result.entries).toHaveLength(2);

    const versions = await listVersions(ctx, target);
    expect(versions.map((version) => [version.versionNumber, version.state])).toEqual([
      [2, "active"],
      [1, "superseded"],
    ]);
  });

  it("records the recipe title and revision as they were", async () => {
    const view = await getWeekView(ctx, target);
    const entry = view.entries.find((row) => row.dayOfWeek === 2);
    expect(entry?.recipeTitleSnapshot).toBe("Gratin dauphinois");
    expect(entry?.recipeRevisionSnapshot).toBe(1);
  });

  it("replaces rather than duplicates when the same slot is assigned twice", async () => {
    const result = await assignRecipe(ctx, target, {
      dayOfWeek: 1,
      mealTypeId: dinnerId,
      recipeId: creamyId,
    });
    const monday = result.entries.filter((entry) => entry.dayOfWeek === 1);
    expect(monday).toHaveLength(1);
    expect(monday[0]?.recipeTitleSnapshot).toBe("Gratin dauphinois");
  });
});

describe("slot rules", () => {
  it("refuses a slot the user marked as skipped, and names the alternatives", async () => {
    await setSlotConfig(ctx, {
      dayOfWeek: 5,
      mealTypeId: dinnerId,
      state: "skipped",
      timeBudgetMin: null,
      defaultServings: null,
    });

    let thrown: unknown;
    try {
      await assignRecipe(ctx, week(4), {
        dayOfWeek: 5,
        mealTypeId: dinnerId,
        recipeId: quickId,
      });
    } catch (error) {
      thrown = error;
    }

    const error = thrown as DomainError;
    expect(error.code).toBe("SLOT_NOT_PLANNED");
    expect(Array.isArray(error.details.available)).toBe(true);
  });

  it("refuses a (day, meal) that is not configured at all", async () => {
    let thrown: unknown;
    try {
      await assignRecipe(ctx, week(4), {
        dayOfWeek: 3,
        mealTypeId: lunchId,
        recipeId: quickId,
      });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as DomainError).code).toBe("SLOT_UNKNOWN");
  });

  it("keeps an entry as orphaned when its slot stops being planned", async () => {
    const target = week(5);
    await assignRecipe(ctx, target, {
      dayOfWeek: 6,
      mealTypeId: dinnerId,
      recipeId: quickId,
    });

    await setSlotConfig(ctx, {
      dayOfWeek: 6,
      mealTypeId: dinnerId,
      state: "hidden",
      timeBudgetMin: null,
      defaultServings: null,
    });

    const view = await getWeekView(ctx, target);
    expect(view.entries).toHaveLength(0);
    expect(view.orphanedEntries).toHaveLength(1);
    expect(view.orphanedEntries[0]?.recipeTitleSnapshot).toBe("Omelette");

    // Put it back so later tests see the seeded grid.
    await setSlotConfig(ctx, {
      dayOfWeek: 6,
      mealTypeId: dinnerId,
      state: "planned",
      timeBudgetMin: null,
      defaultServings: null,
    });
  });
});

describe("time budget", () => {
  it("blocks a recipe that overruns the slot budget past the tolerance", async () => {
    await setSlotConfig(ctx, {
      dayOfWeek: 2,
      mealTypeId: dinnerId,
      state: "planned",
      timeBudgetMin: 15,
      defaultServings: null,
    });

    let thrown: unknown;
    try {
      await assignRecipe(ctx, week(6), {
        dayOfWeek: 2,
        mealTypeId: dinnerId,
        recipeId: longId,
      });
    } catch (error) {
      thrown = error;
    }

    const error = thrown as DomainError;
    expect(error.code).toBe("TIME_BUDGET_EXCEEDED");
    expect(error.details).toMatchObject({ budgetMin: 15, activeTimeMin: 90 });
  });

  it("warns but writes when the overrun is inside the tolerance", async () => {
    await setSlotConfig(ctx, {
      dayOfWeek: 3,
      mealTypeId: dinnerId,
      state: "planned",
      timeBudgetMin: 20,
      defaultServings: null,
    });

    const result = await assignRecipe(ctx, week(7), {
      dayOfWeek: 3,
      mealTypeId: dinnerId,
      recipeId: creamyId,
    });

    expect(result.entries).toHaveLength(1);
    expect(result.warnings.map((warning) => warning.code)).toContain(
      "TIME_BUDGET_TIGHT",
    );
  });
});

describe("grid editing", () => {
  const target = week(8);
  let mondayEntryId = "";

  it("sets servings and a note without touching other entries", async () => {
    const first = await assignRecipe(ctx, target, {
      dayOfWeek: 1,
      mealTypeId: dinnerId,
      recipeId: quickId,
    });
    mondayEntryId = first.entries[0]!.id;

    const updated = await updateEntry(ctx, target, mondayEntryId, {
      servings: 5,
      note: "doubler pour les restes",
    });

    expect(updated.entries[0]).toMatchObject({
      servings: 5,
      note: "doubler pour les restes",
    });
    // A new id, because the entry lives in a new immutable version.
    expect(updated.entries[0]!.id).not.toBe(mondayEntryId);
    mondayEntryId = updated.entries[0]!.id;
  });

  it("duplicates an entry to another slot, which is how leftovers are expressed", async () => {
    const result = await duplicateEntry(ctx, target, mondayEntryId, {
      dayOfWeek: 4,
      mealTypeId: dinnerId,
    });

    expect(result.entries).toHaveLength(2);
    const thursday = result.entries.find((entry) => entry.dayOfWeek === 4);
    expect(thursday).toMatchObject({
      recipeTitleSnapshot: "Omelette",
      servings: 5,
    });
    mondayEntryId = result.entries.find((entry) => entry.dayOfWeek === 1)!.id;
  });

  it("moves an entry to an empty slot", async () => {
    const result = await moveEntry(ctx, target, mondayEntryId, {
      dayOfWeek: 7,
      mealTypeId: dinnerId,
    });

    expect(result.entries.map((entry) => entry.dayOfWeek).sort()).toEqual([4, 7]);
  });

  it("swaps when moved onto an occupied slot", async () => {
    const view = await getWeekView(ctx, target);
    const sunday = view.entries.find((entry) => entry.dayOfWeek === 7)!;

    const result = await moveEntry(ctx, target, sunday.id, {
      dayOfWeek: 4,
      mealTypeId: dinnerId,
    });

    expect(result.entries.map((entry) => entry.dayOfWeek).sort()).toEqual([4, 7]);
  });

  it("clears one entry and leaves the rest", async () => {
    const view = await getWeekView(ctx, target);
    const first = view.entries[0]!;

    const result = await clearEntry(ctx, target, first.id);
    expect(result.entries).toHaveLength(view.entries.length - 1);
  });
});

describe("version history", () => {
  it("reverts by replaying an older version into a new one", async () => {
    const target = week(9);

    await assignRecipe(ctx, target, {
      dayOfWeek: 1,
      mealTypeId: dinnerId,
      recipeId: quickId,
    });
    const second = await assignRecipe(ctx, target, {
      dayOfWeek: 4,
      mealTypeId: dinnerId,
      recipeId: creamyId,
    });
    expect(second.entries).toHaveLength(2);

    const reverted = await revertToVersion(ctx, target, 1);

    expect(reverted.version.versionNumber).toBe(3);
    expect(reverted.entries).toHaveLength(1);
    expect(reverted.entries[0]?.dayOfWeek).toBe(1);

    // The revert is itself a version, so it is revertible in turn.
    const versions = await listVersions(ctx, target);
    expect(versions.map((version) => version.versionNumber)).toEqual([3, 2, 1]);
    expect(versions.filter((version) => version.state === "active")).toHaveLength(1);
  });

  it("refuses to revert to a version that does not exist", async () => {
    await expect(revertToVersion(ctx, week(9), 99)).rejects.toBeInstanceOf(
      DomainError,
    );
  });
});

describe("the strict allergen block", () => {
  it("refuses to place a recipe containing a strict allergen", async () => {
    await createAllergen(ctx, {
      name: "Lait",
      severity: "strict",
      matches: ["lait", "crème", "beurre"],
    });

    let thrown: unknown;
    try {
      await assignRecipe(ctx, week(10), {
        dayOfWeek: 1,
        mealTypeId: dinnerId,
        recipeId: creamyId,
      });
    } catch (error) {
      thrown = error;
    }

    const error = thrown as DomainError;
    expect(error.code).toBe("STRICT_ALLERGEN");
    expect(error.message).toContain("Gratin dauphinois");

    // Nothing was written: the version does not exist.
    const view = await getWeekView(ctx, week(10));
    expect(view.activeVersion).toBeNull();
  });

  it("blocks the next edit of a week that already contains the allergen", async () => {
    // The allergen was added after week 3 was planned with the creamy recipe.
    // A new version must be valid as a whole, so the edit is refused rather
    // than quietly carrying the violation forward.
    await expect(
      assignRecipe(ctx, week(3), {
        dayOfWeek: 7,
        mealTypeId: dinnerId,
        recipeId: quickId,
      }),
    ).rejects.toMatchObject({ code: "STRICT_ALLERGEN" });
  });

  it("still allows a week with no offending recipe", async () => {
    const result = await assignRecipe(ctx, week(11), {
      dayOfWeek: 1,
      mealTypeId: dinnerId,
      recipeId: quickId,
    });
    expect(result.entries).toHaveLength(1);
  });
});
