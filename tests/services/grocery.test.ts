import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DomainError } from "@/domain/errors";
import {
  addManualLine,
  archiveGroceryList,
  deleteLine,
  generateGroceryList,
  getGroceryList,
  setLineChecked,
  type GroceryListView,
} from "@/services/grocery-service";
import { ensureUserSetup } from "@/services/onboarding-service";
import { assignRecipe, clearEntry, getWeekView } from "@/services/plan-service";
import { createRecipe } from "@/services/recipe-service";
import { listMealTypes } from "@/services/slot-service";
import { cleanupUser, testUser } from "../helpers/fixtures";

/**
 * The behaviour that matters here is the merge. A user standing in a shop with
 * half the list ticked off must not lose that progress because the plan moved,
 * so these tests are mostly about what survives a regeneration.
 */

const ctx = testUser();
const week = { year: 2026, week: 20 };

let dinnerId = "";
let tarteId = "";
let gratinId = "";

function lineNamed(list: GroceryListView, name: string) {
  return list.lines.find((line) => line.displayName === name);
}

beforeAll(async () => {
  await ensureUserSetup(ctx);
  dinnerId = (await listMealTypes(ctx)).find((type) => type.key === "dinner")!.id;

  tarteId = (
    await createRecipe(ctx, {
      title: "Tarte à l'oignon",
      servings: 2,
      activeTimeMin: 20,
      ingredients: [
        { rawName: "farine", quantity: 200, unit: "g" },
        { rawName: "oignons", quantity: 2 },
        { rawName: "poivre", optional: true },
      ],
    })
  ).recipe.id;

  gratinId = (
    await createRecipe(ctx, {
      title: "Gratin",
      servings: 2,
      activeTimeMin: 20,
      ingredients: [
        { rawName: "farine", quantity: 100, unit: "g" },
        { rawName: "lait", quantity: 250, unit: "ml" },
      ],
    })
  ).recipe.id;
});

afterAll(async () => {
  await cleanupUser(ctx);
});

describe("generating a list", () => {
  it("refuses when the week has no active plan", async () => {
    await expect(
      generateGroceryList(ctx, { year: 2026, week: 21 }),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it("returns nothing for a week that was never generated", async () => {
    expect(await getGroceryList(ctx, { year: 2026, week: 21 })).toBeNull();
  });

  it("builds a list from the week's active version", async () => {
    await assignRecipe(ctx, week, {
      dayOfWeek: 1,
      mealTypeId: dinnerId,
      recipeId: tarteId,
    });

    const { list, diff } = await generateGroceryList(ctx, week);

    expect(diff.added).toBe(2);
    expect(list.state).toBe("active");
    expect(list.stale).toBe(false);
    expect(lineNamed(list, "Farine")).toMatchObject({
      quantity: 200,
      unit: "g",
      origin: "derived",
      checked: false,
    });
    expect(lineNamed(list, "Oignon")).toMatchObject({ quantity: 2, unit: null });
    // The optional pepper is not on the list.
    expect(lineNamed(list, "Poivre")).toBeUndefined();
  });

  it("names the meals a line came from, so a line can explain itself", async () => {
    const list = (await getGroceryList(ctx, week))!;
    const farine = lineNamed(list, "Farine")!;
    expect(farine.sourceEntryIds).toHaveLength(1);
    const source = list.sources.find(
      (row) => row.entryId === farine.sourceEntryIds[0],
    );
    expect(source).toMatchObject({ dayOfWeek: 1, title: "Tarte à l'oignon" });
  });
});

describe("regenerating after the plan changes", () => {
  it("keeps checked state and manual lines, and reports what moved", async () => {
    const before = (await getGroceryList(ctx, week))!;
    await setLineChecked(ctx, lineNamed(before, "Farine")!.id, true);
    await addManualLine(ctx, before.id, {
      displayName: "Café",
      aisle: "Épicerie salée",
    });

    // A second meal adds flour and milk to the same week.
    await assignRecipe(ctx, week, {
      dayOfWeek: 2,
      mealTypeId: dinnerId,
      recipeId: gratinId,
    });

    const { list, diff } = await generateGroceryList(ctx, week);

    // Flour went from 200 g to 300 g and stayed ticked off.
    const farine = lineNamed(list, "Farine")!;
    expect(farine).toMatchObject({ quantity: 300, unit: "g", checked: true });
    expect(diff.updated).toBe(1);
    expect(diff.changedLineIds).toContain(farine.id);

    // Milk is new, and unchecked.
    expect(lineNamed(list, "Lait")).toMatchObject({
      quantity: 250,
      unit: "ml",
      checked: false,
    });
    expect(diff.added).toBe(1);

    // Onions did not move.
    expect(diff.unchanged).toBe(1);

    // And the manual line is untouched by any of it.
    expect(lineNamed(list, "Café")).toMatchObject({
      origin: "manual",
      quantity: null,
    });
  });

  it("drops a derived line whose meal is gone, and keeps the manual one", async () => {
    const view = await getWeekView(ctx, week);
    const tuesday = view.entries.find((entry) => entry.dayOfWeek === 2)!;
    await clearEntry(ctx, week, tuesday.id);

    const { list, diff } = await generateGroceryList(ctx, week);

    expect(lineNamed(list, "Lait")).toBeUndefined();
    expect(diff.removed).toBe(1);
    expect(lineNamed(list, "Farine")).toMatchObject({ quantity: 200, checked: true });
    expect(lineNamed(list, "Café")).toBeDefined();
  });

  it("stays one list per week rather than one per version", async () => {
    const first = (await getGroceryList(ctx, week))!;
    await generateGroceryList(ctx, week);
    const second = (await getGroceryList(ctx, week))!;
    expect(second.id).toBe(first.id);
  });

  it("reports a list built from a superseded version as stale", async () => {
    await assignRecipe(ctx, week, {
      dayOfWeek: 3,
      mealTypeId: dinnerId,
      recipeId: gratinId,
    });

    const stale = (await getGroceryList(ctx, week))!;
    expect(stale.stale).toBe(true);

    await generateGroceryList(ctx, week);
    expect((await getGroceryList(ctx, week))!.stale).toBe(false);
  });
});

describe("editing the list by hand", () => {
  it("adds, checks and deletes a manual line", async () => {
    const list = (await getGroceryList(ctx, week))!;
    const added = await addManualLine(ctx, list.id, {
      displayName: "Liquide vaisselle",
      quantity: 1,
    });

    await setLineChecked(ctx, added.id, true);
    expect(lineNamed((await getGroceryList(ctx, week))!, "Liquide vaisselle")).
      toMatchObject({ checked: true });

    await deleteLine(ctx, added.id);
    expect(
      lineNamed((await getGroceryList(ctx, week))!, "Liquide vaisselle"),
    ).toBeUndefined();
  });

  it("refuses an empty manual line", async () => {
    const list = (await getGroceryList(ctx, week))!;
    await expect(
      addManualLine(ctx, list.id, { displayName: "   " }),
    ).rejects.toBeInstanceOf(DomainError);
  });

  it("archives a list", async () => {
    const list = (await getGroceryList(ctx, week))!;
    await archiveGroceryList(ctx, list.id);
    const archived = await getGroceryList(ctx, week);
    expect(archived?.state).toBe("archived");
  });
});
