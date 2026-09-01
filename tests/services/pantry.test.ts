import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { formatCycleStart } from "@/domain/shopping";
import { isoWeekStart } from "@/domain/week";
import { DomainError } from "@/domain/errors";
import { currentIsoWeek } from "@/domain/week";
import { agentContext } from "@/services/context";
import { generateGroceryList } from "@/services/grocery-service";
import { ensureUserSetup } from "@/services/onboarding-service";
import {
  addPantryItems,
  listPantry,
  removePantryItem,
} from "@/services/pantry-service";
import { assignRecipe } from "@/services/plan-service";
import { createRecipe } from "@/services/recipe-service";
import { listMealTypes } from "@/services/slot-service";
import { composeProfileSnapshot } from "@/services/snapshot-service";
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
 * Two short lists, and what they change downstream: a grocery list that leaves
 * out what you already have, and a snapshot that tells an agent what to use up.
 */

const ctx = testUser();
const agent = agentContext(ctx.userId, "client-pantry");
const week = currentIsoWeek();

beforeAll(async () => {
  await ensureUserSetup(ctx);
  const dinnerId = (await listMealTypes(ctx)).find(
    (type) => type.key === "dinner",
  )!.id;

  const recipeId = (
    await createRecipe(ctx, {
      title: "Pâtes à l'huile d'olive",
      servings: 2,
      activeTimeMin: 15,
      ingredients: [
        { rawName: "pâtes", quantity: 200, unit: "g" },
        { rawName: "huile d'olive", quantity: 2, unit: "c. à s." },
        { rawName: "courgette", quantity: 1 },
      ],
    })
  ).recipe.id;

  await assignRecipe(ctx, week, { dayOfWeek: 1, mealTypeId: dinnerId, recipeId });
});

afterAll(async () => {
  await cleanupUser(ctx);
});

describe("the lists themselves", () => {
  it("keeps quantities as free text, never as a number", async () => {
    const [item] = await addPantryItems(ctx, [
      {
        kind: "staple",
        name: "Pâtes",
        quantityNote: "il en reste un paquet et demi",
      },
    ]);

    expect(item).toMatchObject({
      kind: "staple",
      quantityNote: "il en reste un paquet et demi",
      source: "user",
    });
  });

  it("stamps an agent's addition as its own", async () => {
    const [item] = await addPantryItems(agent, [
      { kind: "use_soon", name: "Courgette", expiresOn: "2026-12-01" },
    ]);
    expect(item).toMatchObject({ source: "agent", expiresOn: "2026-12-01" });
  });

  it("links what it recognizes, so a grocery line can be matched later", async () => {
    const items = await listPantry(ctx);
    const pasta = items.find((row) => row.name === "Pâtes");
    expect(pasta?.ingredientId).not.toBeNull();
  });

  it("refuses to remove something that is not there", async () => {
    await expect(
      removePantryItem(ctx, "00000000-0000-4000-8000-000000000000"),
    ).rejects.toBeInstanceOf(DomainError);
  });
});

describe("what the pantry does to a grocery list", () => {
  it("marks a staple as covered rather than dropping the line", async () => {
    const { list } = await generateGroceryList(ctx, cycleOf(week));

    const pasta = list.lines.find((line) => line.displayName === "Pâtes");
    // Still there, so the user can check it. Being out of pasta the one week it
    // vanished silently is exactly the failure this avoids.
    expect(pasta).toBeDefined();
    expect(pasta?.coveredByPantry).toBe(true);

    const oil = list.lines.find((line) => line.displayName === "Huile d'olive");
    expect(oil?.coveredByPantry).toBe(false);
  });

  it("marks a use-soon ingredient so it gets finished", async () => {
    const { list } = await generateGroceryList(ctx, cycleOf(week));
    const courgette = list.lines.find(
      (line) => line.displayName === "Courgette",
    );
    expect(courgette?.useSoon).toBe(true);
  });

  it("re-evaluates coverage on every regeneration", async () => {
    await addPantryItems(ctx, [{ kind: "staple", name: "Huile d'olive" }]);

    const { list } = await generateGroceryList(ctx, cycleOf(week));
    const oil = list.lines.find((line) => line.displayName === "Huile d'olive");
    // A staple added since the last generation drops off now, not next week.
    expect(oil?.coveredByPantry).toBe(true);
  });
});

describe("what the pantry tells an agent", () => {
  it("puts use-soon items in the snapshot as a planning priority", async () => {
    const { markdown, snapshot } = await composeProfileSnapshot(ctx);

    expect(snapshot.pantry.useSoon.map((item) => item.name)).toContain(
      "Courgette",
    );
    expect(snapshot.pantry.staples.map((item) => item.name)).toContain("Pâtes");
    expect(markdown).toContain("**À consommer bientôt.**");
    expect(markdown).toContain("proposez de préférence des plats qui les utilisent");
  });
});
