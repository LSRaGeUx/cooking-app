import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { formatCycleStart } from "@/domain/shopping";
import { isoWeekStart } from "@/domain/week";
import {
  addManualLine,
  archiveGroceryList,
  deleteLine,
  generateGroceryList,
  getGroceryList,
  setLineChecked,
  type GroceryListView,
} from "@/services/grocery-service";
import { addPantryItems, removePantryItem } from "@/services/pantry-service";
import { assignRecipe, clearEntry, getWeekView } from "@/services/plan-service";
import { createRecipe } from "@/services/recipe-service";
import type { ServiceContext } from "@/services/context";
import { cycleOf, expectDomainError, setupTestUser } from "../helpers";

/**
 * The behaviour that matters here is the merge. A user standing in a shop with
 * half the list ticked off must not lose that progress because the plan moved,
 * so these tests are mostly about what survives a regeneration.
 */

let user: Awaited<ReturnType<typeof setupTestUser>>;
let ctx: ServiceContext;
const week = { year: 2026, week: 20 };

let dinnerId = "";
let tarteId = "";
let gratinId = "";

function lineNamed(list: GroceryListView, name: string) {
  return list.lines.find((line) => line.displayName === name);
}

beforeAll(async () => {
  user = await setupTestUser();
  ctx = user.ctx;
  dinnerId = user.dinnerId;

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
  await user.cleanup();
});

describe("generating a list", () => {
  it("refuses when the week has no active plan", async () => {
    await expectDomainError(
      generateGroceryList(ctx, cycleOf({ year: 2026, week: 21 })),
      "NOT_FOUND",
    );
  });

  it("returns nothing for a week that was never generated", async () => {
    expect(
      await getGroceryList(ctx, cycleOf({ year: 2026, week: 21 })),
    ).toBeNull();
  });

  it("builds a list from the week's active version", async () => {
    await assignRecipe(ctx, week, {
      dayOfWeek: 1,
      mealTypeId: dinnerId,
      recipeId: tarteId,
    });

    const { list, diff } = await generateGroceryList(ctx, cycleOf(week));

    expect(diff.added).toBe(3);
    expect(list.state).toBe("active");
    expect(list.stale).toBe(false);
    expect(lineNamed(list, "Farine")).toMatchObject({
      quantity: 200,
      unit: "g",
      origin: "derived",
      checked: false,
    });
    expect(lineNamed(list, "Oignon")).toMatchObject({
      quantity: 2,
      unit: null,
    });
    // The optional pepper is on the list, flagged: the screen shops it from a
    // section of its own rather than hiding it or mixing it into an aisle.
    expect(lineNamed(list, "Poivre")).toMatchObject({ optional: true });
    expect(lineNamed(list, "Farine")).toMatchObject({ optional: false });
  });

  it("names the meals a line came from, so a line can explain itself", async () => {
    const list = (await getGroceryList(ctx, cycleOf(week)))!;
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
    const before = (await getGroceryList(ctx, cycleOf(week)))!;
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

    const { list, diff } = await generateGroceryList(ctx, cycleOf(week));

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

    // Onions and the optional pepper did not move.
    expect(diff.unchanged).toBe(2);

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

    const { list, diff } = await generateGroceryList(ctx, cycleOf(week));

    expect(lineNamed(list, "Lait")).toBeUndefined();
    expect(diff.removed).toBe(1);
    expect(lineNamed(list, "Farine")).toMatchObject({
      quantity: 200,
      checked: true,
    });
    expect(lineNamed(list, "Café")).toBeDefined();
  });

  it("stays one list per week rather than one per version", async () => {
    const first = (await getGroceryList(ctx, cycleOf(week)))!;
    await generateGroceryList(ctx, cycleOf(week));
    const second = (await getGroceryList(ctx, cycleOf(week)))!;
    expect(second.id).toBe(first.id);
  });

  it("reports a list built from a superseded version as stale", async () => {
    await assignRecipe(ctx, week, {
      dayOfWeek: 3,
      mealTypeId: dinnerId,
      recipeId: gratinId,
    });

    const stale = (await getGroceryList(ctx, cycleOf(week)))!;
    expect(stale.stale).toBe(true);

    await generateGroceryList(ctx, cycleOf(week));
    expect((await getGroceryList(ctx, cycleOf(week)))!.stale).toBe(false);
  });
});

describe("editing the list by hand", () => {
  it("adds, checks and deletes a manual line", async () => {
    const list = (await getGroceryList(ctx, cycleOf(week)))!;
    const added = await addManualLine(ctx, list.id, {
      displayName: "Liquide vaisselle",
      quantity: 1,
    });

    await setLineChecked(ctx, added.id, true);
    expect(
      lineNamed(
        (await getGroceryList(ctx, cycleOf(week)))!,
        "Liquide vaisselle",
      ),
    ).toMatchObject({ checked: true });

    await deleteLine(ctx, added.id);
    expect(
      lineNamed(
        (await getGroceryList(ctx, cycleOf(week)))!,
        "Liquide vaisselle",
      ),
    ).toBeUndefined();
  });

  it("refuses an empty manual line", async () => {
    const list = (await getGroceryList(ctx, cycleOf(week)))!;

    // A `ZodError`, not a `DomainError`, and that is the intended shape here.
    // The service validates with `manualLineInputSchema`, which is what makes
    // the schema the single source of truth rather than a second opinion beside
    // a hand-rolled check. Both entry points turn it into a `VALIDATION` with
    // the field path: `runAction` in src/app/actions/result.ts, and `runTool`
    // in src/mcp/tool-runner.ts. Those mappings are what the caller sees, and
    // they are tested where they live.
    await expect(
      addManualLine(ctx, list.id, { displayName: "   " }),
    ).rejects.toThrow(ZodError);

    // The refusal is what matters: nothing was written.
    expect(
      lineNamed((await getGroceryList(ctx, cycleOf(week)))!, "   "),
    ).toBeUndefined();
  });

  it("archives a list, and the cycle then starts a fresh one", async () => {
    // Archiving retires the list rather than deleting it, and the cycle stops
    // resolving to it: the screen offers to generate again, and regenerating
    // writes a new list instead of reviving the archived one. The partial
    // unique index says the same thing, one live list per cycle.
    const list = (await getGroceryList(ctx, cycleOf(week)))!;
    await archiveGroceryList(ctx, list.id);

    expect(await getGroceryList(ctx, cycleOf(week))).toBeNull();

    const { list: regenerated } = await generateGroceryList(ctx, cycleOf(week));
    expect(regenerated.id).not.toBe(list.id);
    expect(regenerated.state).toBe("active");
  });
});

/**
 * What a line is called. The vocabulary exists to merge and to derive
 * allergens, not to rename the shopping: "coulis de tomate" resolves to the
 * seeded `Tomate` for its aisle, and a list that says "Tomate" sends the cook
 * to the wrong shelf. Week 40 of 2026, so nothing here touches the merge tests
 * above.
 */
describe("naming the product to buy", () => {
  const namingWeek = { year: 2026, week: 40 };

  it("shops for what the recipe wrote, and still adds two of them up", async () => {
    const sauce = (
      await createRecipe(ctx, {
        title: "Pâtes à la sauce tomate",
        servings: 2,
        activeTimeMin: 15,
        ingredients: [
          { rawName: "coulis de tomate", quantity: 250, unit: "ml" },
          { rawName: "pain de mie", quantity: 2 },
        ],
      })
    ).recipe.id;

    const burgers = (
      await createRecipe(ctx, {
        title: "Burgers maison",
        servings: 2,
        activeTimeMin: 25,
        ingredients: [
          { rawName: "coulis de tomate", quantity: 250, unit: "ml" },
          { rawName: "pain à burger", quantity: 4 },
        ],
      })
    ).recipe.id;

    await assignRecipe(ctx, namingWeek, {
      dayOfWeek: 1,
      mealTypeId: dinnerId,
      recipeId: sauce,
    });
    await assignRecipe(ctx, namingWeek, {
      dayOfWeek: 4,
      mealTypeId: dinnerId,
      recipeId: burgers,
    });

    const { list } = await generateGroceryList(ctx, cycleOf(namingWeek));

    // Both meals asked for a coulis, so one line of 500 ml, under the name a
    // shop would recognise.
    expect(lineNamed(list, "coulis de tomate")).toMatchObject({
      quantity: 500,
      unit: "ml",
    });
    expect(lineNamed(list, "Tomate")).toBeUndefined();

    // Two breads that both resolve to `Pain` are two different purchases.
    expect(lineNamed(list, "pain de mie")).toMatchObject({ quantity: 2 });
    expect(lineNamed(list, "pain à burger")).toMatchObject({ quantity: 4 });
    expect(lineNamed(list, "Pain")).toBeUndefined();
  });

  it("names an alias-linked line after the recipe, and still shelves it", async () => {
    // "spaghetti" is a seeded alias of `Pâtes`. The alias is what gives the
    // line an aisle and an allergen set; it does not make the line pasta in
    // general, so the list says spaghetti.
    const carbonara = (
      await createRecipe(ctx, {
        title: "Carbonara",
        servings: 2,
        activeTimeMin: 20,
        ingredients: [{ rawName: "spaghetti", quantity: 250, unit: "g" }],
      })
    ).recipe.id;

    await assignRecipe(ctx, namingWeek, {
      dayOfWeek: 6,
      mealTypeId: dinnerId,
      recipeId: carbonara,
    });

    const { list } = await generateGroceryList(ctx, cycleOf(namingWeek));

    expect(lineNamed(list, "spaghetti")).toMatchObject({
      quantity: 250,
      unit: "g",
      aisle: "Épicerie salée",
    });
    expect(lineNamed(list, "Pâtes")).toBeUndefined();
  });

  it("does not let a staple cover a narrower product that resolved to it", async () => {
    const [staple] = await addPantryItems(ctx, [
      { kind: "staple", name: "tomates" },
    ]);

    const { list } = await generateGroceryList(ctx, cycleOf(namingWeek));
    expect(lineNamed(list, "coulis de tomate")).toMatchObject({
      coveredByPantry: false,
    });

    await removePantryItem(ctx, staple!.id);
  });
});

/**
 * The shopping cycle is the point of the feature: a list covers the days
 * between two shops, which is rarely a Monday-to-Sunday week. These use week 30
 * and 31 of 2026, whose Monday is 20 July, so a Thursday cycle starts on the
 * 23rd and runs to the 29th, taking the tail of one week and the head of the
 * next.
 */
describe("shopping cycles", () => {
  const first = { year: 2026, week: 30 };
  const second = { year: 2026, week: 31 };

  it("covers two weeks and drops what was cooked before it starts", async () => {
    // Monday of week 30: before the cycle, so already cooked and already
    // bought. Thursday of week 30 and Monday of week 31: inside it.
    await assignRecipe(ctx, first, {
      dayOfWeek: 1,
      mealTypeId: dinnerId,
      recipeId: gratinId,
    });
    await assignRecipe(ctx, first, {
      dayOfWeek: 4,
      mealTypeId: dinnerId,
      recipeId: tarteId,
    });
    await assignRecipe(ctx, second, {
      dayOfWeek: 1,
      mealTypeId: dinnerId,
      recipeId: gratinId,
    });

    const thursday = formatCycleStart(
      new Date(isoWeekStart(first).getTime() + 3 * 86_400_000),
    );
    expect(thursday).toBe("2026-07-23");

    const { list } = await generateGroceryList(ctx, thursday);

    expect(list.startsOn).toBe("2026-07-23");
    expect(list.endsOn).toBe("2026-07-29");

    // The tarte is Thursday, inside. The gratin is Monday of the next week,
    // also inside. Monday of week 30 is outside, so its 100 g of flour is not
    // counted: the total is the tarte's 200 plus the second gratin's 100.
    expect(lineNamed(list, "Oignon")?.quantity).toBe(2);
    expect(lineNamed(list, "Lait")?.quantity).toBe(250);
    expect(lineNamed(list, "Farine")?.quantity).toBe(300);
  });

  it("keeps one live list per cycle, and neighbouring cycles are separate", async () => {
    const thursday = "2026-07-23";
    const nextThursday = "2026-07-30";

    const again = await generateGroceryList(ctx, thursday);
    const neighbour = await generateGroceryList(ctx, nextThursday);

    expect(again.list.id).not.toBe(neighbour.list.id);
    expect(neighbour.list.startsOn).toBe(nextThursday);
    // Planning the next cycle leaves this one exactly as it was, which is the
    // worry that started the whole feature.
    expect((await getGroceryList(ctx, thursday))!.id).toBe(again.list.id);
  });

  it("refuses a cycle start that is not a date", async () => {
    await expectDomainError(generateGroceryList(ctx, "2026-W30"), "VALIDATION");
    await expectDomainError(
      generateGroceryList(ctx, "2026-02-30"),
      "VALIDATION",
    );
  });
});
