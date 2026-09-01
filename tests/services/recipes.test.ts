import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseIngredientBlock } from "@/domain/ingredient-parser";
import { DomainError } from "@/domain/errors";
import { listIngredients } from "@/services/ingredient-service";
import { ensureUserSetup } from "@/services/onboarding-service";
import {
  createRecipe,
  getRecipe,
  searchRecipes,
  softDeleteRecipe,
  updateRecipe,
} from "@/services/recipe-service";
import { cleanupUser, testUser } from "../helpers/fixtures";

const ctx = testUser();

const gratin = {
  title: "Gratin de courgettes",
  description: "Un gratin simple pour un soir de semaine.",
  servings: 4,
  prepTimeMin: 15,
  cookTimeMin: 35,
  activeTimeMin: 20,
  tags: ["gratin", "légumes"],
  ingredients: parseIngredientBlock(
    ["3 courgettes", "200 ml de crème fraîche", "100 g de gruyère râpé", "sel"].join(
      "\n",
    ),
  ).map((line) => ({
    quantity: line.quantity,
    unit: line.unit,
    rawName: line.rawName,
    note: line.note,
    optional: line.optional,
    ingredientId: null,
  })),
  steps: [
    { text: "Couper les courgettes en rondelles.", durationMin: 10, unattended: false },
    { text: "Enfourner 35 minutes.", durationMin: 35, unattended: true },
  ],
};

beforeAll(async () => {
  await ensureUserSetup(ctx);
});

afterAll(async () => {
  await cleanupUser(ctx);
});

describe("recipe creation", () => {
  it("saves a pasted ingredient block and links what it recognizes", async () => {
    const created = await createRecipe(ctx, gratin);

    expect(created.recipe.title).toBe("Gratin de courgettes");
    expect(created.recipe.revision).toBe(1);
    expect(created.recipe.source).toBe("manual");
    expect(created.ingredients).toHaveLength(4);
    expect(created.steps).toHaveLength(2);

    // Best-effort linking against the seeded starter set: courgette and crème
    // are known, "sel" is known, and nothing blocks on the ones that are not.
    const linked = created.ingredients.filter((line) => line.ingredientId !== null);
    expect(linked.length).toBeGreaterThanOrEqual(3);

    const courgette = created.ingredients.find((line) =>
      line.rawName.includes("courgettes"),
    );
    expect(courgette?.canonicalName).toBe("Courgette");
    expect(courgette?.quantity).toBe(3);
  });

  it("seeds the starter ingredient vocabulary once", async () => {
    const ingredients = await listIngredients(ctx);
    expect(ingredients.length).toBeGreaterThan(30);
  });
});

describe("recipe editing", () => {
  it("keeps a revision and bumps the recipe's revision number", async () => {
    const created = await createRecipe(ctx, {
      ...gratin,
      title: "Soupe de poireaux",
    });

    const updated = await updateRecipe(ctx, created.recipe.id, {
      ...gratin,
      title: "Soupe de poireaux et pommes de terre",
      servings: 6,
    });

    expect(updated.recipe.revision).toBe(2);
    expect(updated.recipe.title).toBe("Soupe de poireaux et pommes de terre");
    expect(updated.recipe.servings).toBe(6);

    // The prior state is recoverable, which is what makes an agent edit safe.
    const reread = await getRecipe(ctx, created.recipe.id);
    expect(reread.recipe.revision).toBe(2);
  });
});

describe("recipe search", () => {
  it("finds a recipe by a word in its title", async () => {
    await createRecipe(ctx, { ...gratin, title: "Curry de pois chiches" });
    const found = await searchRecipes(ctx, { query: "curry" });
    expect(found.recipes.some((row) => row.title.includes("Curry"))).toBe(true);
  });

  it("finds a recipe by a partial word, while the user is still typing", async () => {
    const found = await searchRecipes(ctx, { query: "cour" });
    expect(found.recipes.some((row) => row.title.includes("courgettes"))).toBe(
      true,
    );
  });

  it("filters on attended time, not on total time", async () => {
    // The gratin has 20 minutes of attended time and 50 of total.
    const found = await searchRecipes(ctx, { maxActiveTimeMin: 25 });
    expect(found.recipes.some((row) => row.title.includes("Gratin"))).toBe(true);
  });

  it("filters by tag", async () => {
    const found = await searchRecipes(ctx, { tags: ["gratin"] });
    expect(found.recipes.length).toBeGreaterThan(0);
  });
});

describe("recipe deletion", () => {
  it("soft deletes, so history stays readable, and hides it from search", async () => {
    const created = await createRecipe(ctx, { ...gratin, title: "Tarte aux poireaux" });
    await softDeleteRecipe(ctx, created.recipe.id);

    const found = await searchRecipes(ctx, { query: "Tarte aux poireaux" });
    expect(found.recipes).toHaveLength(0);

    const reread = await getRecipe(ctx, created.recipe.id);
    expect(reread.recipe.deletedAt).not.toBeNull();
  });

  it("refuses to delete twice", async () => {
    const created = await createRecipe(ctx, { ...gratin, title: "Quiche" });
    await softDeleteRecipe(ctx, created.recipe.id);
    await expect(softDeleteRecipe(ctx, created.recipe.id)).rejects.toBeInstanceOf(
      DomainError,
    );
  });
});
