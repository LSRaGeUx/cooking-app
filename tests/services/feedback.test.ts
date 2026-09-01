import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DomainError } from "@/domain/errors";
import { currentIsoWeek, shiftIsoWeek } from "@/domain/week";
import {
  loadFeedbackForEntries,
  pendingFeedback,
  recordFeedback,
} from "@/services/feedback-service";
import {
  loadHistory,
  loadRecipeStats,
  loadSignals,
} from "@/services/history-service";
import { ensureUserSetup } from "@/services/onboarding-service";
import { assignRecipe, getWeekView, moveEntry } from "@/services/plan-service";
import { createRecipe, loadRecipeIndex, searchRecipes } from "@/services/recipe-service";
import { listMealTypes, setSlotConfig } from "@/services/slot-service";
import { cleanupUser, testUser } from "../helpers/fixtures";

/**
 * The loop that makes week 20 better than week 1.
 *
 * The distinction these tests keep insisting on: a meal with no feedback is
 * unjudged, not failed. Everything downstream depends on not confusing the two.
 */

const ctx = testUser();
let dinnerId = "";
let lovedId = "";
let ignoredId = "";
let futureId = "";

const pastWeek = shiftIsoWeek(currentIsoWeek(), -2);
const olderWeek = shiftIsoWeek(currentIsoWeek(), -4);

beforeAll(async () => {
  await ensureUserSetup(ctx);
  dinnerId = (await listMealTypes(ctx)).find((type) => type.key === "dinner")!.id;

  const make = async (title: string) =>
    (
      await createRecipe(ctx, {
        title,
        servings: 2,
        activeTimeMin: 30,
        ingredients: [{ rawName: "sel" }],
      })
    ).recipe.id;

  lovedId = await make("Plat adoré");
  ignoredId = await make("Plat jamais cuisiné");
  // Its own recipe, so planning a future week does not distort the counts the
  // signal tests read.
  futureId = await make("Plat de la semaine prochaine");
});

afterAll(async () => {
  await cleanupUser(ctx);
});

describe("recording what happened", () => {
  it("stores an outcome with nothing else required", async () => {
    const result = await assignRecipe(ctx, pastWeek, {
      dayOfWeek: 1,
      mealTypeId: dinnerId,
      recipeId: lovedId,
    });
    const entry = result.entries[0]!;

    const feedback = await recordFeedback(ctx, entry.id, { outcome: "cooked" });

    expect(feedback).toMatchObject({
      outcome: "cooked",
      rating: null,
      note: null,
      tookLonger: false,
    });
  });

  it("corrects a previous answer rather than stacking a second one", async () => {
    const view = await getWeekView(ctx, pastWeek);
    const entry = view.entries[0]!;

    await recordFeedback(ctx, entry.id, {
      outcome: "cooked",
      rating: 5,
      tookLonger: true,
    });

    const stored = await loadFeedbackForEntries(ctx, [entry.id]);
    expect(stored.size).toBe(1);
    expect(stored.get(entry.id)).toMatchObject({ rating: 5, tookLonger: true });
  });

  it("refuses feedback on a meal that is not yours", async () => {
    await expect(
      recordFeedback(ctx, "00000000-0000-4000-8000-000000000000", {
        outcome: "cooked",
      }),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it("survives an edit to the week", async () => {
    // Plan versions are immutable, so editing rewrites the entry rows. The
    // verdict has to follow the slot, or a user who tidies their week silently
    // loses everything they recorded.
    const before = await getWeekView(ctx, pastWeek);
    const entry = before.entries[0]!;

    const moved = await moveEntry(ctx, pastWeek, entry.id, {
      dayOfWeek: 3,
      mealTypeId: dinnerId,
    });

    const carried = await loadFeedbackForEntries(
      ctx,
      moved.entries.map((row) => row.id),
    );
    expect(carried.size).toBe(1);
    expect([...carried.values()][0]).toMatchObject({
      outcome: "cooked",
      rating: 5,
    });
  });
});

describe("prompting for what is missing", () => {
  it("asks only about days that have already passed", async () => {
    const future = shiftIsoWeek(currentIsoWeek(), 3);
    await assignRecipe(ctx, future, {
      dayOfWeek: 1,
      mealTypeId: dinnerId,
      recipeId: futureId,
    });

    const pending = await pendingFeedback(ctx, future);
    expect(pending).toEqual([]);
  });

  it("lists a past meal with no verdict yet", async () => {
    await assignRecipe(ctx, olderWeek, {
      dayOfWeek: 2,
      mealTypeId: dinnerId,
      recipeId: ignoredId,
    });

    const pending = await pendingFeedback(ctx, olderWeek);
    expect(pending.map((row) => row.recipeTitle)).toContain(
      "Plat jamais cuisiné",
    );
  });

  it("stops asking once answered", async () => {
    const view = await getWeekView(ctx, olderWeek);
    const entry = view.entries[0]!;
    await recordFeedback(ctx, entry.id, { outcome: "skipped" });

    const pending = await pendingFeedback(ctx, olderWeek);
    expect(pending.some((row) => row.entryId === entry.id)).toBe(false);
  });
});

describe("derived signals", () => {
  it("counts planned against cooked per recipe", async () => {
    const stats = await loadRecipeStats(ctx);
    const loved = stats.find((row) => row.title === "Plat adoré");

    expect(loved).toMatchObject({ planned: 1, cooked: 1, averageRating: 5 });
    expect(loved?.weeksSinceLastCooked).toBe(2);
  });

  it("does not count a skipped meal as cooked", async () => {
    const stats = await loadRecipeStats(ctx);
    const ignored = stats.find((row) => row.title === "Plat jamais cuisiné");
    expect(ignored).toMatchObject({ planned: 1, cooked: 0, skipped: 1 });
    expect(ignored?.weeksSinceLastCooked).toBeNull();
  });

  it("raises never-cooked only once a dish has been planned twice", async () => {
    let report = await loadSignals(ctx);
    expect(
      report.signals.some(
        (signal) => signal.code === "NEVER_COOKED_THOUGH_PLANNED",
      ),
    ).toBe(false);

    // Planned a second time, still never cooked. Now it means something.
    await assignRecipe(ctx, shiftIsoWeek(currentIsoWeek(), -5), {
      dayOfWeek: 4,
      mealTypeId: dinnerId,
      recipeId: ignoredId,
    });

    report = await loadSignals(ctx);
    const signal = report.signals.find(
      (row) => row.code === "NEVER_COOKED_THOUGH_PLANNED",
    );
    expect(signal?.message).toContain("Plat jamais cuisiné");
  });

  it("suggests a bigger budget for a slot that keeps running over", async () => {
    await setSlotConfig(ctx, {
      dayOfWeek: 6,
      mealTypeId: dinnerId,
      state: "planned",
      timeBudgetMin: 20,
      defaultServings: null,
    });

    // Three Saturdays, all of them over. One would be noise; three is a budget
    // that does not match the kitchen.
    for (const offset of [-6, -7, -8]) {
      const week = shiftIsoWeek(currentIsoWeek(), offset);
      const result = await assignRecipe(ctx, week, {
        dayOfWeek: 6,
        mealTypeId: dinnerId,
        recipeId: lovedId,
      });
      const entry = result.entries.find((row) => row.dayOfWeek === 6)!;
      await recordFeedback(ctx, entry.id, {
        outcome: "cooked",
        tookLonger: true,
      });
    }

    const report = await loadSignals(ctx);
    const suggestion = report.budgetSuggestions.find(
      (row) => row.dayOfWeek === 6,
    );

    expect(suggestion).toBeDefined();
    expect(suggestion!.currentBudgetMin).toBe(20);
    // The recipe needs 30 attended minutes, rounded to the next five.
    expect(suggestion!.suggestedBudgetMin).toBe(30);
  });

  it("reports history without pretending an unjudged meal failed", async () => {
    const history = await loadHistory(ctx, 12);
    const meals = history.flatMap((week) => week.entries);
    expect(meals.some((meal) => meal.outcome === null)).toBe(true);
    expect(meals.some((meal) => meal.outcome === "cooked")).toBe(true);
  });
});

describe("what the feedback unlocks for searching", () => {
  it("filters on what was actually cooked, not on what was planned", async () => {
    const notCooked = await searchRecipes(ctx, {
      notCookedInWeeks: 4,
      limit: 50,
    });
    const titles = notCooked.recipes.map((row) => row.title);

    // Cooked two weeks ago, so it is excluded.
    expect(titles).not.toContain("Plat adoré");
    // Planned but never cooked, so it passes.
    expect(titles).toContain("Plat jamais cuisiné");
  });

  it("excludes a never-rated recipe from a minimum rating", async () => {
    const rated = await searchRecipes(ctx, { minRating: 4, limit: 50 });
    const titles = rated.recipes.map((row) => row.title);

    expect(titles).toContain("Plat adoré");
    // An absent rating is not a good rating.
    expect(titles).not.toContain("Plat jamais cuisiné");
  });

  it("puts cook data on the index an agent surveys", async () => {
    const index = await loadRecipeIndex(ctx);
    const loved = index.find((row) => row.title === "Plat adoré");
    expect(loved).toMatchObject({ timesCooked: 4, averageRating: 5 });
    expect(loved?.weeksSinceLastCooked).not.toBeNull();
  });
});
