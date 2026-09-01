import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatCycleStart } from "@/domain/shopping";
import { isoWeekStart } from "@/domain/week";
import { currentIsoWeek } from "@/domain/week";
import { deleteAccount, exportAccount } from "@/services/account-service";
import { createFact } from "@/services/fact-service";
import { generateGroceryList } from "@/services/grocery-service";
import { ensureUserSetup } from "@/services/onboarding-service";
import { addPantryItems } from "@/services/pantry-service";
import { assignRecipe } from "@/services/plan-service";
import { createRecipe } from "@/services/recipe-service";
import { listMealTypes } from "@/services/slot-service";
import { cleanupUser, testUser } from "../helpers/fixtures";

/**
 * Grocery lists cover a shopping cycle, not a week. These tests plan by week,
 * so they shop on the Monday cycle of that week, which is exactly the fallback
 * an account with no shopping day set gets.
 */
function cycleOf(week: { year: number; week: number }): string {
  return formatCycleStart(isoWeekStart(week));
}

/**
 * Taking your data out, and taking your account down.
 *
 * The deletion half is the reason this file exists. Domain tables carry no
 * foreign key to the Better Auth user, so nothing cascades on its own and the
 * order of twenty deletes is written by hand. A table left out of that list
 * leaves rows behind that nobody can ever see again, and no other test would
 * notice.
 */

const leaving = testUser();
const staying = testUser();
const week = currentIsoWeek();

beforeAll(async () => {
  for (const ctx of [leaving, staying]) {
    await ensureUserSetup(ctx);

    const dinnerId = (await listMealTypes(ctx)).find(
      (type) => type.key === "dinner",
    )!.id;

    const recipeId = (
      await createRecipe(ctx, {
        title: "Soupe de courge",
        servings: 2,
        activeTimeMin: 20,
        ingredients: [
          { rawName: "courge", quantity: 1 },
          { rawName: "oignon", quantity: 1 },
        ],
        steps: [{ text: "Tout cuire." }],
      })
    ).recipe.id;

    await assignRecipe(ctx, week, {
      dayOfWeek: 1,
      mealTypeId: dinnerId,
      recipeId,
    });
    await generateGroceryList(ctx, cycleOf(week));
    await addPantryItems(ctx, [{ kind: "staple", name: "farine" }]);
    await createFact(ctx, {
      statement: "N'aime pas la coriandre",
      category: "taste",
    });
  }
});

afterAll(async () => {
  await cleanupUser(leaving);
  await cleanupUser(staying);
});

describe("exporting an account", () => {
  it("carries every part of the account, in one document", async () => {
    const data = await exportAccount(leaving);

    expect(data.format).toBe("cooking-app/v1");
    expect(data.profile).not.toBeNull();

    // Named explicitly rather than counted, so a table dropped from the export
    // fails here instead of quietly shrinking the file.
    for (const key of [
      "facts",
      "mealTypes",
      "slots",
      "ingredients",
      "recipes",
      "recipeIngredients",
      "recipeSteps",
      "plans",
      "planVersions",
      "planEntries",
      "pantryItems",
      "groceryLists",
      "groceryLines",
    ]) {
      expect(Array.isArray(data[key]), `${key} missing`).toBe(true);
      expect((data[key] as unknown[]).length, `${key} empty`).toBeGreaterThan(0);
    }
  });

  it("holds nothing belonging to anyone else", async () => {
    // The export reads through withUser, so this is really a test that row-level
    // security still covers the one query that reads every table at once.
    const data = await exportAccount(leaving);
    const serialized = JSON.stringify(data);

    expect(serialized).toContain(leaving.userId);
    expect(serialized).not.toContain(staying.userId);
  });
});

describe("deleting an account", () => {
  it("removes everything, and leaves the other account untouched", async () => {
    await deleteAccount(leaving);

    const emptied = await exportAccount(leaving);
    expect(emptied.profile).toBeNull();
    for (const key of [
      "facts",
      "mealTypes",
      "slots",
      "ingredients",
      "recipes",
      "recipeIngredients",
      "recipeSteps",
      "plans",
      "planVersions",
      "planEntries",
      "pantryItems",
      "groceryLists",
      "groceryLines",
      "agentActivity",
    ]) {
      expect(emptied[key], `${key} left rows behind`).toEqual([]);
    }

    const survivor = await exportAccount(staying);
    expect(survivor.profile).not.toBeNull();
    expect((survivor.recipes as unknown[]).length).toBeGreaterThan(0);
    expect((survivor.groceryLines as unknown[]).length).toBeGreaterThan(0);
  });
});
