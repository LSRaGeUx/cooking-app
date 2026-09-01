import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { currentIsoWeek, shiftIsoWeek, weeksBetween } from "@/domain/week";
import { ensureUserSetup } from "@/services/onboarding-service";
import { assignRecipe } from "@/services/plan-service";
import {
  createRecipe,
  loadRecipeIndex,
  searchRecipes,
} from "@/services/recipe-service";
import { listMealTypes } from "@/services/slot-service";
import { cleanupUser, testUser } from "../helpers/fixtures";

/**
 * What an agent surveys before choosing, and the filter that answers "something
 * I have not had in a while". Both read planned history, not cooked history:
 * feedback does not exist until phase 6, and the naming says so.
 */

const ctx = testUser();
let dinnerId = "";
let recentId = "";
let oldId = "";
let neverId = "";

beforeAll(async () => {
  await ensureUserSetup(ctx);
  dinnerId = (await listMealTypes(ctx)).find((type) => type.key === "dinner")!.id;

  const make = async (title: string) =>
    (
      await createRecipe(ctx, {
        title,
        servings: 2,
        activeTimeMin: 15,
        ingredients: [{ rawName: "sel" }],
      })
    ).recipe.id;

  recentId = await make("Plat de cette semaine");
  oldId = await make("Plat d'il y a cinq semaines");
  neverId = await make("Plat jamais planifié");

  const thisWeek = currentIsoWeek();
  await assignRecipe(ctx, thisWeek, {
    dayOfWeek: 1,
    mealTypeId: dinnerId,
    recipeId: recentId,
  });
  await assignRecipe(ctx, shiftIsoWeek(thisWeek, -5), {
    dayOfWeek: 1,
    mealTypeId: dinnerId,
    recipeId: oldId,
  });
});

afterAll(async () => {
  await cleanupUser(ctx);
});

describe("the recipe index", () => {
  it("reports how long since each recipe was last planned", async () => {
    const index = await loadRecipeIndex(ctx);
    const byTitle = new Map(index.map((row) => [row.title, row]));

    expect(byTitle.get("Plat de cette semaine")).toMatchObject({
      weeksSinceLastPlanned: 0,
      timesPlanned: 1,
    });
    expect(byTitle.get("Plat d'il y a cinq semaines")).toMatchObject({
      weeksSinceLastPlanned: 5,
      timesPlanned: 1,
    });
    expect(byTitle.get("Plat jamais planifié")).toMatchObject({
      weeksSinceLastPlanned: null,
      timesPlanned: 0,
    });
  });

  it("stays compact: no ingredients, no steps", async () => {
    const index = await loadRecipeIndex(ctx);
    const entry = index[0]!;
    expect(entry).not.toHaveProperty("ingredients");
    expect(entry).not.toHaveProperty("steps");
  });
});

describe("the not-planned-in-weeks filter", () => {
  it("excludes what was planned recently and keeps the rest", async () => {
    const found = await searchRecipes(ctx, { notPlannedInWeeks: 4, limit: 50 });
    const titles = found.recipes.map((row) => row.title);

    expect(titles).not.toContain("Plat de cette semaine");
    expect(titles).toContain("Plat d'il y a cinq semaines");
    expect(titles).toContain("Plat jamais planifié");
  });

  it("widens correctly as the window grows", async () => {
    const found = await searchRecipes(ctx, { notPlannedInWeeks: 10, limit: 50 });
    const titles = found.recipes.map((row) => row.title);

    expect(titles).not.toContain("Plat de cette semaine");
    expect(titles).not.toContain("Plat d'il y a cinq semaines");
    expect(titles).toContain("Plat jamais planifié");
  });

  it("returns everything when no window is asked for", async () => {
    const found = await searchRecipes(ctx, { limit: 50 });
    expect(found.recipes).toHaveLength(3);
  });
});

describe("week arithmetic behind the filter", () => {
  it("counts whole weeks across a year boundary", () => {
    // A bare week-number subtraction would say -52 here.
    expect(weeksBetween({ year: 2026, week: 53 }, { year: 2027, week: 1 })).toBe(1);
    expect(weeksBetween({ year: 2027, week: 1 }, { year: 2026, week: 53 })).toBe(-1);
    expect(weeksBetween({ year: 2026, week: 10 }, { year: 2026, week: 10 })).toBe(0);
  });
});
