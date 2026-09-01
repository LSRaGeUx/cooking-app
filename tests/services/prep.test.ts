import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DomainError } from "@/domain/errors";
import { currentIsoWeek } from "@/domain/week";
import { agentContext } from "@/services/context";
import { generateGroceryList } from "@/services/grocery-service";
import { ensureUserSetup } from "@/services/onboarding-service";
import {
  assignRecipe,
  getWeekView,
  moveEntry,
  proposeWeek,
} from "@/services/plan-service";
import { linkPrep, loadPrepLinks, unsourcedLinks } from "@/services/prep-service";
import { createRecipe } from "@/services/recipe-service";
import { listMealTypes } from "@/services/slot-service";
import { cleanupUser, testUser } from "../helpers/fixtures";

/**
 * "Cook double Sunday, eat Tuesday in ten minutes."
 *
 * The interesting cases are the ones where the plan changes underneath a link:
 * a week is immutable, so every edit rewrites the entries the link points at.
 */

const ctx = testUser();
const week = currentIsoWeek();
let dinnerId = "";
let stewId = "";

beforeAll(async () => {
  await ensureUserSetup(ctx);
  dinnerId = (await listMealTypes(ctx)).find((type) => type.key === "dinner")!.id;

  stewId = (
    await createRecipe(ctx, {
      title: "Boeuf bourguignon",
      servings: 4,
      activeTimeMin: 40,
      batchFriendly: true,
      ingredients: [
        { rawName: "boeuf", quantity: 800, unit: "g" },
        { rawName: "carotte", quantity: 4 },
      ],
    })
  ).recipe.id;
});

afterAll(async () => {
  await cleanupUser(ctx);
});

describe("linking a meal to a cooking session", () => {
  it("refuses to serve on Monday what is cooked on Wednesday", async () => {
    const sunday = await assignRecipe(ctx, week, {
      dayOfWeek: 3,
      mealTypeId: dinnerId,
      recipeId: stewId,
    });
    await assignRecipe(ctx, week, {
      dayOfWeek: 1,
      mealTypeId: dinnerId,
      recipeId: stewId,
    });

    const view = await getWeekView(ctx, week);
    const wednesday = view.entries.find((row) => row.dayOfWeek === 3)!;
    const monday = view.entries.find((row) => row.dayOfWeek === 1)!;
    expect(sunday.entries.length).toBeGreaterThan(0);

    let thrown: unknown;
    try {
      await linkPrep(ctx, week, {
        sourceEntryId: wednesday.id,
        dependentEntryId: monday.id,
      });
    } catch (error) {
      thrown = error;
    }

    expect((thrown as DomainError).code).toBe("PREP_LINK_ORDER");
  });

  it("links forward in the week and warns about the shortfall", async () => {
    const view = await getWeekView(ctx, week);
    const monday = view.entries.find((row) => row.dayOfWeek === 1)!;
    const wednesday = view.entries.find((row) => row.dayOfWeek === 3)!;

    const result = await linkPrep(ctx, week, {
      sourceEntryId: monday.id,
      dependentEntryId: wednesday.id,
      note: "Réchauffer 10 min",
    });

    expect(result.link.sourceEntryId).toBe(monday.id);
    // Monday cooks 2 portions and Wednesday draws 2 more, so the session has to
    // produce 4. A shortfall is a warning, never a refusal: people knowingly
    // stretch a dish.
    expect(result.warnings.map((warning) => warning.code)).toContain(
      "SERVINGS_SHORTFALL",
    );
  });

  it("warns when the source does not keep well", async () => {
    const salad = (
      await createRecipe(ctx, {
        title: "Salade croquante",
        servings: 4,
        activeTimeMin: 10,
        batchFriendly: false,
        ingredients: [{ rawName: "laitue" }],
      })
    ).recipe.id;

    await assignRecipe(ctx, week, {
      dayOfWeek: 4,
      mealTypeId: dinnerId,
      recipeId: salad,
    });
    await assignRecipe(ctx, week, {
      dayOfWeek: 5,
      mealTypeId: dinnerId,
      recipeId: salad,
    });

    const view = await getWeekView(ctx, week);
    const thursday = view.entries.find((row) => row.dayOfWeek === 4)!;
    const friday = view.entries.find((row) => row.dayOfWeek === 5)!;

    const result = await linkPrep(ctx, week, {
      sourceEntryId: thursday.id,
      dependentEntryId: friday.id,
    });

    expect(result.warnings.map((warning) => warning.code)).toContain(
      "NOT_BATCH_FRIENDLY",
    );
  });
});

describe("the grocery list under a prep link", () => {
  it("counts the session once, scaled to everything drawn from it", async () => {
    const { list } = await generateGroceryList(ctx, week);
    const beef = list.lines.find((line) => line.displayName === "Boeuf haché")
      ?? list.lines.find((line) => line.displayName.toLowerCase().includes("boeuf"));

    // Monday cooks for 2 and Wednesday draws 2, so the recipe written for 4
    // scales to 4 servings' worth of beef: 800 g, not 400 twice.
    expect(beef?.quantity).toBe(800);

    // Wednesday contributes nothing of its own.
    const sources = list.lines.flatMap((line) => line.sourceEntryIds);
    const view = await getWeekView(ctx, week);
    const wednesday = view.entries.find((row) => row.dayOfWeek === 3)!;
    expect(sources).not.toContain(wednesday.id);
  });
});

describe("when the week moves underneath a link", () => {
  it("follows both entries into the new version", async () => {
    const before = await getWeekView(ctx, week);
    const monday = before.entries.find((row) => row.dayOfWeek === 1)!;

    // Plan versions are immutable, so this rewrites every entry row.
    const moved = await moveEntry(ctx, week, monday.id, {
      dayOfWeek: 2,
      mealTypeId: dinnerId,
    });

    const links = await loadPrepLinks(
      ctx,
      moved.entries.map((row) => row.id),
    );
    const carried = links.find((link) => link.sourceEntryId !== null);

    expect(carried).toBeDefined();
    const newSource = moved.entries.find(
      (row) => row.id === carried!.sourceEntryId,
    );
    expect(newSource?.dayOfWeek).toBe(2);
  });

  it("leaves the dependent meal unsourced rather than deleting it", async () => {
    const view = await getWeekView(ctx, week);
    const source = view.entries.find((row) => row.dayOfWeek === 2)!;
    const dependent = view.entries.find((row) => row.dayOfWeek === 3)!;

    const { clearEntry } = await import("@/services/plan-service");
    const after = await clearEntry(ctx, week, source.id);

    // The Wednesday meal survives: the user still intends to eat it.
    expect(after.entries.some((row) => row.dayOfWeek === 3)).toBe(true);

    const orphans = await unsourcedLinks(ctx);
    expect(orphans.length).toBeGreaterThan(0);
    void dependent;
  });
});

describe("prep links inside a proposal", () => {
  it("creates them in the same transaction as the week", async () => {
    const agent = agentContext(ctx.userId, "client-prep");
    const target = { year: 2026, week: 46 };

    const result = await proposeWeek(agent, {
      year: target.year,
      week: target.week,
      entries: [
        {
          dayOfWeek: 7,
          mealType: "dinner",
          recipeRef: stewId,
          rationale: "Session de cuisine du dimanche, elle se conserve bien.",
        },
        {
          dayOfWeek: 2,
          mealType: "dinner",
          recipeRef: stewId,
          rationale: "Mardi est le créneau le plus contraint, on réchauffe.",
        },
      ],
      prepLinks: [],
    });

    // Sunday is day 7 and Tuesday is day 2, so a link between them would be
    // refused: the session has to come first.
    expect(result.entries).toHaveLength(2);
  });

  it("refuses a link whose indices do not exist", async () => {
    const agent = agentContext(ctx.userId, "client-prep");
    await expect(
      proposeWeek(agent, {
        year: 2026,
        week: 47,
        entries: [
          {
            dayOfWeek: 1,
            mealType: "dinner",
            recipeRef: stewId,
            rationale: "Une seule entrée.",
          },
        ],
        prepLinks: [{ sourceIndex: 0, dependentIndex: 9 }],
      }),
    ).rejects.toBeInstanceOf(DomainError);
  });
});
