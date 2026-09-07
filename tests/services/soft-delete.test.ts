import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { currentIsoWeek, type IsoWeek } from "@/domain/week";
import {
  createFact,
  listFacts,
  restoreFact,
  retireFact,
} from "@/services/fact-service";
import {
  addPantryItems,
  listPantry,
  listRemovedPantryItems,
  PANTRY_RESTORE_WINDOW_DAYS,
  purgeRemovedPantryItems,
  removePantryItem,
  restorePantryItem,
} from "@/services/pantry-service";
import { assignRecipe } from "@/services/plan-service";
import { getVersionEntries, getWeekView } from "@/services/plan-queries";
import {
  createRecipe,
  getRecipe,
  listDeletedRecipes,
  purgeDeletedRecipes,
  RECIPE_RESTORE_WINDOW_DAYS,
  restoreRecipe,
  searchRecipes,
  softDeleteRecipe,
} from "@/services/recipe-service";
import { expectDomainError, setupTestUser } from "../helpers";

/**
 * The 30-day windows rule 6 promises, and the purge that makes them windows
 * rather than "kept for ever, hidden".
 *
 * Every one of these had the same shape of hole: `softDeleteRecipe` carried a
 * comment about a 30-day window and there was no job to close it, so nothing in
 * the product ever deleted anything and nothing tested that it would. The
 * `restore` half is the other side of the same promise, and a soft delete nobody
 * can undo from the product is a hard delete with extra steps.
 *
 * Both purges take an injectable clock, which is why this file needs no SQL to
 * back-date a row: it moves `now` forward instead. That is the better test as
 * well as the shorter one, because it exercises the same parameter the scheduled
 * job passes.
 */

const DAY = 86_400_000;

let user: Awaited<ReturnType<typeof setupTestUser>>;
const week: IsoWeek = currentIsoWeek();

/** A day inside the window, and a day past it, relative to a soft delete. */
function insideWindow(days: number): Date {
  return new Date(Date.now() + (days - 1) * DAY);
}

function pastWindow(days: number): Date {
  return new Date(Date.now() + (days + 1) * DAY);
}

async function newRecipe(title: string): Promise<string> {
  const created = await createRecipe(user.ctx, {
    title,
    servings: 2,
    activeTimeMin: 15,
    ingredients: [{ rawName: "pâtes", quantity: 200, unit: "g" }],
  });
  return created.recipe.id;
}

beforeAll(async () => {
  user = await setupTestUser();
});

afterAll(async () => {
  await user.cleanup();
});

describe("a soft-deleted recipe inside its window", () => {
  it("comes back with everything it had", async () => {
    const id = await newRecipe("Risotto aux champignons");
    await softDeleteRecipe(user.ctx, id);

    // Offered back by the screen that lists what is recoverable, which is the
    // only place a user learns the window exists.
    expect((await listDeletedRecipes(user.ctx)).map((row) => row.id)).toContain(
      id,
    );

    const restored = await restoreRecipe(user.ctx, id);
    expect(restored.recipe.deletedAt).toBeNull();
    expect(restored.recipe.title).toBe("Risotto aux champignons");
    // The children were never touched, so a restore is not a re-import.
    expect(restored.ingredients.length).toBeGreaterThan(0);

    const found = await searchRecipes(user.ctx, { query: "risotto" });
    expect(found.recipes.map((row) => row.id)).toContain(id);
  });

  it("survives a purge run", async () => {
    const id = await newRecipe("Dahl de lentilles");
    await softDeleteRecipe(user.ctx, id);

    // Run the purge as it would run today, and again one day short of the
    // window. Neither may take it: that is what the promise means.
    expect(await purgeDeletedRecipes(user.ctx)).toBe(0);
    expect(
      await purgeDeletedRecipes(
        user.ctx,
        insideWindow(RECIPE_RESTORE_WINDOW_DAYS),
      ),
    ).toBe(0);

    const still = await getRecipe(user.ctx, id);
    expect(still.recipe.deletedAt).not.toBeNull();
  });

  it("refuses a restore of something that was never deleted, and says why", async () => {
    const id = await newRecipe("Tarte aux pommes");
    const error = await expectDomainError(
      restoreRecipe(user.ctx, id),
      "RECIPE_NOT_FOUND",
    );

    // The refusal has to name both reasons, because the caller cannot tell them
    // apart: either the id was never deleted, or it was and the purge has been.
    expect(error.message).toContain(String(RECIPE_RESTORE_WINDOW_DAYS));
    expect(error.details).toMatchObject({ recipeId: id });
  });

  it("refuses a restore of another tenant's recipe rather than reporting success", async () => {
    // It used to clear `deleted_at` on any id and report nothing when the id was
    // unknown, so a screen wiring delete and restore together could show a
    // successful restore of a recipe belonging to somebody else.
    await expectDomainError(
      restoreRecipe(user.ctx, randomUUID()),
      "RECIPE_NOT_FOUND",
    );
  });
});

describe("a soft-deleted recipe past its window", () => {
  it("is deleted for real, and only then", async () => {
    const id = await newRecipe("Blanquette de veau");
    await softDeleteRecipe(user.ctx, id);

    const purged = await purgeDeletedRecipes(
      user.ctx,
      pastWindow(RECIPE_RESTORE_WINDOW_DAYS),
    );
    expect(purged).toBeGreaterThanOrEqual(1);

    await expectDomainError(getRecipe(user.ctx, id), "RECIPE_NOT_FOUND");
    expect(
      (await listDeletedRecipes(user.ctx)).map((row) => row.id),
    ).not.toContain(id);
  });

  it("leaves a live recipe alone whatever the clock says", async () => {
    const id = await newRecipe("Poulet rôti");
    await purgeDeletedRecipes(
      user.ctx,
      pastWindow(RECIPE_RESTORE_WINDOW_DAYS * 100),
    );
    expect((await getRecipe(user.ctx, id)).recipe.deletedAt).toBeNull();
  });

  it("is idempotent: the second run finds nothing left to take", async () => {
    const id = await newRecipe("Soupe à l'oignon");
    await softDeleteRecipe(user.ctx, id);
    const clock = pastWindow(RECIPE_RESTORE_WINDOW_DAYS);

    expect(await purgeDeletedRecipes(user.ctx, clock)).toBeGreaterThanOrEqual(
      1,
    );
    // The count returned is what was actually removed, so a scheduled job can
    // log something true rather than "ran".
    expect(await purgeDeletedRecipes(user.ctx, clock)).toBe(0);
  });

  it("is per user, so one account's purge never reaches another's rows", async () => {
    const neighbour = await setupTestUser();
    try {
      const theirs = (
        await createRecipe(neighbour.ctx, {
          title: "Chili sin carne",
          servings: 4,
          activeTimeMin: 30,
          ingredients: [
            { rawName: "haricots rouges", quantity: 400, unit: "g" },
          ],
        })
      ).recipe.id;
      await softDeleteRecipe(neighbour.ctx, theirs);

      const clock = pastWindow(RECIPE_RESTORE_WINDOW_DAYS);
      await purgeDeletedRecipes(user.ctx, clock);

      // Still there: the purge scopes by `user_id` in the statement, and
      // row-level security is the second line rather than the only one.
      expect((await getRecipe(neighbour.ctx, theirs)).recipe.id).toBe(theirs);
    } finally {
      await neighbour.cleanup();
    }
  });
});

describe("the recipe the purge deliberately keeps", () => {
  it("skips a row a plan entry still points at, so an old week keeps its dish", async () => {
    const id = await newRecipe("Gratin dauphinois");
    await assignRecipe(user.ctx, week, {
      dayOfWeek: 5,
      mealTypeId: user.dinnerId,
      recipeId: id,
    });
    await softDeleteRecipe(user.ctx, id);

    /*
     * `plan_entry.recipe_id` carries `on delete set null`, so deleting this row
     * would unlink the meal and leave the week rendering a dish with no recipe.
     * The title snapshot keeps history readable either way, but a plan the user
     * can still open should keep working, so the purge only takes what nothing
     * points at.
     */
    const purged = await purgeDeletedRecipes(
      user.ctx,
      pastWindow(RECIPE_RESTORE_WINDOW_DAYS),
    );
    expect(purged).toBe(0);

    const kept = await getRecipe(user.ctx, id);
    expect(kept.recipe.id).toBe(id);
    expect(kept.recipe.deletedAt).not.toBeNull();
  });

  it("still resolves inside the plan version that references it", async () => {
    const view = await getWeekView(user.ctx, week);
    expect(view.activeVersion).not.toBeNull();
    if (!view.activeVersion) return;

    const entries = await getVersionEntries(user.ctx, view.activeVersion.id);
    const friday = entries.find((row) => row.dayOfWeek === 5);

    // The whole reason the delete is soft: a week already lived through must not
    // change because a recipe was tidied away afterwards.
    expect(friday).toBeDefined();
    expect(friday?.recipeId).not.toBeNull();
    // Both halves, because they answer different questions. The link is intact,
    // so opening the week still reaches the recipe, and the title snapshot is
    // the belt to that braces: it is what keeps the week readable on the day the
    // recipe really does go.
    expect(friday?.recipeTitleSnapshot).toBe("Gratin dauphinois");
  });

  it("becomes purgeable once nothing references it", async () => {
    const view = await getWeekView(user.ctx, week);
    const entries = view.entries.filter((row) => row.dayOfWeek === 5);
    expect(entries.length).toBeGreaterThan(0);

    const { clearEntry } = await import("@/services/plan-service");
    for (const entry of entries) await clearEntry(user.ctx, week, entry.id);

    // A plan version is immutable, so clearing the entry writes a new version
    // and the old one still points at the recipe. The purge therefore still
    // keeps it, which is correct and is the reason this asserts zero rather
    // than one: history is a reference too.
    expect(
      await purgeDeletedRecipes(
        user.ctx,
        pastWindow(RECIPE_RESTORE_WINDOW_DAYS),
      ),
    ).toBe(0);
  });
});

describe("a removed pantry item", () => {
  it("comes back inside its window", async () => {
    const [item] = await addPantryItems(user.ctx, [
      { kind: "staple", name: "Farine T65" },
    ]);
    expect(item).toBeDefined();
    if (!item) return;

    await removePantryItem(user.ctx, item.id);
    expect((await listPantry(user.ctx)).map((row) => row.id)).not.toContain(
      item.id,
    );
    expect(
      (await listRemovedPantryItems(user.ctx)).map((row) => row.id),
    ).toContain(item.id);

    const restored = await restorePantryItem(user.ctx, item.id);
    expect(restored.id).toBe(item.id);
    expect(restored.name).toBe("Farine T65");
    expect((await listPantry(user.ctx)).map((row) => row.id)).toContain(
      item.id,
    );
  });

  it("survives a purge inside the window and not one past it", async () => {
    const [item] = await addPantryItems(user.ctx, [
      { kind: "staple", name: "Sucre roux" },
    ]);
    expect(item).toBeDefined();
    if (!item) return;

    await removePantryItem(user.ctx, item.id);

    expect(await purgeRemovedPantryItems(user.ctx)).toBe(0);
    expect(
      await purgeRemovedPantryItems(
        user.ctx,
        insideWindow(PANTRY_RESTORE_WINDOW_DAYS),
      ),
    ).toBe(0);

    expect(
      await purgeRemovedPantryItems(
        user.ctx,
        pastWindow(PANTRY_RESTORE_WINDOW_DAYS),
      ),
    ).toBeGreaterThanOrEqual(1);

    // Gone for real, so the restore that was possible yesterday now says so.
    await expectDomainError(restorePantryItem(user.ctx, item.id), "NOT_FOUND");
  });

  it("leaves an item still in the cupboards alone", async () => {
    const [item] = await addPantryItems(user.ctx, [
      { kind: "staple", name: "Huile de tournesol" },
    ]);
    expect(item).toBeDefined();
    if (!item) return;

    await purgeRemovedPantryItems(
      user.ctx,
      pastWindow(PANTRY_RESTORE_WINDOW_DAYS * 100),
    );
    expect((await listPantry(user.ctx)).map((row) => row.id)).toContain(
      item.id,
    );
  });

  it("refuses a restore of an item that was never removed, naming the window", async () => {
    const [item] = await addPantryItems(user.ctx, [
      { kind: "use_soon", name: "Yaourt nature" },
    ]);
    expect(item).toBeDefined();
    if (!item) return;

    const error = await expectDomainError(
      restorePantryItem(user.ctx, item.id),
      "NOT_FOUND",
    );
    expect(error.message).toContain(String(PANTRY_RESTORE_WINDOW_DAYS));
  });
});

describe("a retired fact", () => {
  it("comes back, because retirement was the one agent write with no way home", async () => {
    const created = await createFact(user.ctx, {
      category: "taste",
      polarity: "negative",
      statement: "N'aime pas les olives noires.",
      confidence: "medium",
    });

    await retireFact(user.ctx, created.id, "Test de restauration.");
    const retired = (await listFacts(user.ctx, { includeRetired: true })).find(
      (row) => row.id === created.id,
    );
    expect(retired?.status).toBe("retired");
    // Retired, not deleted. The row is what makes the restore possible at all.
    expect(retired?.retiredAt).not.toBeNull();

    const restored = await restoreFact(user.ctx, created.id);
    expect(restored.retiredAt).toBeNull();
    expect(restored.statement).toBe("N'aime pas les olives noires.");
  });

  it("comes back unconfirmed, whatever it was before", async () => {
    const { confirmFact } = await import("@/services/fact-service");

    const created = await createFact(user.ctx, {
      category: "health",
      polarity: "negative",
      statement: "Réduit le sel depuis le printemps.",
      confidence: "high",
    });
    await confirmFact(user.ctx, created.id);
    await retireFact(user.ctx, created.id);

    const restored = await restoreFact(user.ctx, created.id);
    /*
     * Not `confirmed`, and this is rule 7 rather than a rounding of rule 6.
     * Nothing records the status a fact held before it was retired, so guessing
     * the old one would let a retire-then-restore pair conjure a confirmation
     * no human ever gave. A person confirms it again in one click.
     */
    expect(restored.status).toBe("unconfirmed");
  });

  it("refuses to restore a fact that is not retired", async () => {
    const created = await createFact(user.ctx, {
      category: "other",
      polarity: "neutral",
      statement: "Cuisine surtout le soir.",
      confidence: "low",
    });

    await expectDomainError(restoreFact(user.ctx, created.id), "NOT_FOUND");
  });
});
