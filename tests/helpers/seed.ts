import { currentIsoWeek, type IsoWeek } from "@/domain/week";
import { logAgentActivity } from "@/lib/activity-log";
import type { ServiceContext } from "@/services/context";
import { recordFeedback } from "@/services/feedback-service";
import { createFact } from "@/services/fact-service";
import { addManualLine, generateGroceryList } from "@/services/grocery-service";
import { ensureUserSetup } from "@/services/onboarding-service";
import { addPantryItems } from "@/services/pantry-service";
import { assignRecipe } from "@/services/plan-service";
import { linkPrep } from "@/services/prep-service";
import {
  createAllergen,
  createEquipment,
  createExclusion,
} from "@/services/profile-service";
import { createRecipe, updateRecipe } from "@/services/recipe-service";
import { listMealTypes } from "@/services/slot-service";
import { cycleOf } from "./index";

/**
 * A user with at least one row in every user-owned table.
 *
 * Two tests need this, and both need it for the same reason: they enumerate the
 * tables rather than list them, and an enumeration over empty tables passes
 * vacuously. `tests/rls.test.ts` asserts an unscoped read of each table returns
 * nothing, which is trivially true of a table with no rows at all, and
 * `tests/services/account.test.ts` asserts deletion empties each table, which is
 * trivially true of a table deletion never had to touch.
 *
 * So both assert `rowsSeeded > 0` per table against this seed, and that is the
 * part that makes a new table fail the suite: adding one to the schema without
 * adding a write here leaves it empty, both tests say which table it was, and
 * the fix is to seed it and to check it really is scoped.
 *
 * Everything goes through the services rather than through raw inserts, on
 * purpose. A raw insert would seed a row the application itself can no longer
 * produce, and the row shapes here are the ones the product actually writes.
 */
export interface SeededAccount {
  readonly ctx: ServiceContext;
  readonly week: IsoWeek;
  readonly dinnerId: string;
  readonly recipeId: string;
  readonly groceryListId: string;
  readonly mondayEntryId: string;
}

export async function seedEveryUserOwnedTable(
  ctx: ServiceContext,
): Promise<SeededAccount> {
  // profile, meal_type, slot_config and the starter ingredient vocabulary.
  await ensureUserSetup(ctx);

  const mealTypes = await listMealTypes(ctx);
  const dinner = mealTypes.find((type) => type.key === "dinner");
  if (!dinner) {
    throw new Error(
      `ensureUserSetup did not seed a dinner meal type. Got: ${mealTypes
        .map((type) => type.key)
        .join(", ")}`,
    );
  }

  // allergen, exclusion, equipment. The allergen is `avoid` rather than
  // `strict` deliberately: a strict one would refuse the assignment below,
  // which is exactly what rule 2 promises and not what this seed is for.
  await createAllergen(ctx, {
    name: "Arachide",
    severity: "avoid",
    matches: ["arachide", "cacahuète"],
  });
  await createExclusion(ctx, { name: "Coriandre", matches: ["coriandre"] });
  await createEquipment(ctx, { key: "cocotte", label: "Cocotte en fonte" });

  // fact
  await createFact(ctx, {
    statement: "Cuisine surtout le soir, jamais plus de trente minutes.",
    category: "organization",
  });

  // recipe, recipe_ingredient, recipe_step, and more ingredient rows.
  const created = await createRecipe(ctx, {
    title: "Soupe de courge",
    servings: 4,
    activeTimeMin: 20,
    ingredients: [
      { rawName: "1 courge butternut" },
      { rawName: "2 oignons" },
      { rawName: "50 cl de bouillon" },
    ],
    steps: [
      { text: "Éplucher la courge." },
      { text: "Mijoter vingt minutes." },
    ],
  });
  const recipeId = created.recipe.id;

  // recipe_revision: an edit keeps the previous state, which is rule 5 applied
  // to recipes rather than to plan versions.
  await updateRecipe(ctx, recipeId, {
    title: "Soupe de courge au curry",
    servings: 4,
    activeTimeMin: 25,
    ingredients: [
      { rawName: "1 courge butternut" },
      { rawName: "2 oignons" },
      { rawName: "1 c. à c. de curry" },
    ],
    steps: [
      { text: "Éplucher la courge." },
      { text: "Mijoter vingt minutes." },
    ],
  });

  // plan, plan_version, plan_entry. Two entries, because a prep link needs a
  // source and a dependent, and the source cannot fall after the dependent.
  const week = currentIsoWeek();
  await assignRecipe(ctx, week, {
    dayOfWeek: 1,
    mealTypeId: dinner.id,
    recipeId,
  });
  const assigned = await assignRecipe(ctx, week, {
    dayOfWeek: 3,
    mealTypeId: dinner.id,
    recipeId,
  });

  const monday = assigned.entries.find((entry) => entry.dayOfWeek === 1);
  const wednesday = assigned.entries.find((entry) => entry.dayOfWeek === 3);
  if (!monday || !wednesday) {
    throw new Error(
      "The seed expected a Monday and a Wednesday entry in the active week " +
        `and got days ${assigned.entries.map((entry) => entry.dayOfWeek).join(", ")}.`,
    );
  }

  // prep_link: Wednesday reheats what Monday cooked.
  await linkPrep(ctx, week, {
    sourceEntryId: monday.id,
    dependentEntryId: wednesday.id,
    servingsDrawn: 2,
    note: "Au frigo, réchauffer dix minutes.",
  });

  // entry_feedback
  await recordFeedback(ctx, monday.id, { outcome: "cooked", rating: 4 });

  // pantry_item
  await addPantryItems(ctx, [{ kind: "staple", name: "Farine" }]);

  // grocery_list, grocery_list_version, grocery_line
  const { list } = await generateGroceryList(ctx, cycleOf(week));
  await addManualLine(ctx, list.id, { displayName: "Sacs poubelle" });

  // agent_activity
  await logAgentActivity({
    userId: ctx.userId,
    oauthClientId: null,
    toolName: "get_week",
    direction: "read",
    result: "ok",
    payloadSummary: { week: `${week.year}-W${week.week}` },
  });

  return {
    ctx,
    week,
    dinnerId: dinner.id,
    recipeId,
    groceryListId: list.id,
    mondayEntryId: monday.id,
  };
}
