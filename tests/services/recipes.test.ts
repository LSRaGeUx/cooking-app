import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { withUser } from "@/db/client";
import { recipeRevision } from "@/db/schema";
import { parseIngredientBlock } from "@/domain/ingredient-parser";
import { listIngredients } from "@/services/ingredient-service";
import {
  createRecipe,
  getRecipe,
  searchRecipes,
  softDeleteRecipe,
  updateRecipe,
} from "@/services/recipe-service";
import { expectDomainError, setupTestUser } from "../helpers";

let user: Awaited<ReturnType<typeof setupTestUser>>;
let ctx: Awaited<ReturnType<typeof setupTestUser>>["ctx"];

const gratin = {
  title: "Gratin de courgettes",
  description: "Un gratin simple pour un soir de semaine.",
  servings: 4,
  prepTimeMin: 15,
  cookTimeMin: 35,
  activeTimeMin: 20,
  tags: ["gratin", "légumes"],
  ingredients: parseIngredientBlock(
    [
      "3 courgettes",
      "200 ml de crème fraîche",
      "100 g de gruyère râpé",
      "sel",
    ].join("\n"),
  ).map((line) => ({
    quantity: line.quantity,
    unit: line.unit,
    rawName: line.rawName,
    note: line.note,
    optional: line.optional,
    ingredientId: null,
  })),
  steps: [
    {
      text: "Couper les courgettes en rondelles.",
      durationMin: 10,
      unattended: false,
    },
    { text: "Enfourner 35 minutes.", durationMin: 35, unattended: true },
  ],
};

beforeAll(async () => {
  user = await setupTestUser();
  ctx = user.ctx;
});

afterAll(async () => {
  await user.cleanup();
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
    const linked = created.ingredients.filter(
      (line) => line.ingredientId !== null,
    );
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

    const reread = await getRecipe(ctx, created.recipe.id);
    expect(reread.recipe.revision).toBe(2);

    /*
     * The comment here used to say "the prior state is recoverable, which is
     * what makes an agent edit safe" and then assert only that the revision
     * number was 2. A counter proves a counter: `updateRecipe` could have
     * bumped it and written no revision row at all, or written an empty one,
     * and nothing would have failed. Rule 5 is about the old state surviving,
     * so the row is read and the old values are checked.
     *
     * Read straight from the table, because no service exposes revisions yet.
     * `withUser` rather than the owner connection on purpose: the row has to be
     * visible to the tenant that owns it, since a revision nobody can read is
     * not a revision anybody can restore from.
     */
    const revisions = await withUser(ctx.userId, (tx) =>
      tx
        .select()
        .from(recipeRevision)
        .where(
          and(
            eq(recipeRevision.recipeId, created.recipe.id),
            eq(recipeRevision.userId, ctx.userId),
          ),
        ),
    );

    expect(revisions).toHaveLength(1);
    const [snapshot] = revisions;
    // Revision 1, the state before the edit, not the state after it.
    expect(snapshot?.revision).toBe(1);

    const before = snapshot?.snapshot as {
      recipe: { title: string; servings: number; revision: number };
      ingredients: unknown[];
      steps: unknown[];
    };
    expect(before.recipe.title).toBe("Soupe de poireaux");
    expect(before.recipe.servings).toBe(4);
    expect(before.recipe.revision).toBe(1);
    // The children are in the snapshot too, so a restore would not come back
    // as a title with no ingredients.
    expect(before.ingredients).toHaveLength(4);
    expect(before.steps).toHaveLength(2);
  });

  it("keeps one revision row per edit, in order", async () => {
    const created = await createRecipe(ctx, {
      ...gratin,
      title: "Velouté de potiron",
    });
    await updateRecipe(ctx, created.recipe.id, { ...gratin, title: "V2" });
    await updateRecipe(ctx, created.recipe.id, { ...gratin, title: "V3" });

    const revisions = await withUser(ctx.userId, (tx) =>
      tx
        .select()
        .from(recipeRevision)
        .where(eq(recipeRevision.recipeId, created.recipe.id)),
    );

    // Two edits, two rows, numbered 1 and 2: the unique constraint on
    // (recipe, revision) is what stops two concurrent edits both claiming the
    // same number, and this is the shape it protects.
    expect(revisions.map((row) => row.revision).sort()).toEqual([1, 2]);
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
    expect(found.recipes.some((row) => row.title.includes("Gratin"))).toBe(
      true,
    );
  });

  it("filters by tag", async () => {
    const found = await searchRecipes(ctx, { tags: ["gratin"] });
    expect(found.recipes.length).toBeGreaterThan(0);
  });
});

describe("recipe deletion", () => {
  it("soft deletes, so history stays readable, and hides it from search", async () => {
    const created = await createRecipe(ctx, {
      ...gratin,
      title: "Tarte aux poireaux",
    });
    await softDeleteRecipe(ctx, created.recipe.id);

    const found = await searchRecipes(ctx, { query: "Tarte aux poireaux" });
    expect(found.recipes).toHaveLength(0);

    const reread = await getRecipe(ctx, created.recipe.id);
    expect(reread.recipe.deletedAt).not.toBeNull();
  });

  it("refuses to delete twice", async () => {
    const created = await createRecipe(ctx, { ...gratin, title: "Quiche" });
    await softDeleteRecipe(ctx, created.recipe.id);
    await expectDomainError(
      softDeleteRecipe(ctx, created.recipe.id),
      "RECIPE_NOT_FOUND",
    );
  });
});
