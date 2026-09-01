import { eq, sql } from "drizzle-orm";
import { db, withUser } from "@/db/client";
import {
  agentActivity,
  allergen,
  entryFeedback,
  equipment,
  exclusion,
  fact,
  groceryLine,
  groceryList,
  ingredient,
  mealType,
  pantryItem,
  plan,
  planEntry,
  planVersion,
  prepLink,
  profile,
  recipe,
  recipeIngredient,
  recipeRevision,
  recipeStep,
  slotConfig,
} from "@/db/schema";
import type { ServiceContext } from "./context";

/**
 * Taking your data out, and taking your account down.
 *
 * Both exist because a self-hosted product that cannot be left is not really
 * self-hosted. The export is everything, in one file, in a shape that can be
 * read without this application. The deletion is real: there is no soft-delete
 * hiding an account that says it is gone.
 */

export async function exportAccount(
  ctx: ServiceContext,
): Promise<Record<string, unknown>> {
  return withUser(ctx.userId, async (tx) => {
    // Read through the scoped transaction, so row-level security is the second
    // pair of eyes on an export as much as on anything else.
    const [
      profileRows,
      allergens,
      exclusions,
      equipmentRows,
      facts,
      mealTypes,
      slots,
      ingredients,
      recipes,
      recipeIngredients,
      recipeSteps,
      revisions,
      plans,
      versions,
      entries,
      feedback,
      prepLinks,
      pantry,
      lists,
      lines,
      activity,
    ] = [
      await tx.select().from(profile),
      await tx.select().from(allergen),
      await tx.select().from(exclusion),
      await tx.select().from(equipment),
      await tx.select().from(fact),
      await tx.select().from(mealType),
      await tx.select().from(slotConfig),
      await tx.select().from(ingredient),
      await tx.select().from(recipe),
      await tx.select().from(recipeIngredient),
      await tx.select().from(recipeStep),
      await tx.select().from(recipeRevision),
      await tx.select().from(plan),
      await tx.select().from(planVersion),
      await tx.select().from(planEntry),
      await tx.select().from(entryFeedback),
      await tx.select().from(prepLink),
      await tx.select().from(pantryItem),
      await tx.select().from(groceryList),
      await tx.select().from(groceryLine),
      await tx.select().from(agentActivity),
    ];

    return {
      exportedAt: new Date().toISOString(),
      format: "cooking-app/v1",
      note: "Export complet des données de ce compte. Les tables d'authentification ne sont pas incluses : elles ne contiennent rien que vous n'ayez saisi ailleurs.",
      profile: profileRows[0] ?? null,
      allergens,
      exclusions,
      equipment: equipmentRows,
      facts,
      mealTypes,
      slots,
      ingredients,
      recipes,
      recipeIngredients,
      recipeSteps,
      recipeRevisions: revisions,
      plans,
      planVersions: versions,
      planEntries: entries,
      entryFeedback: feedback,
      prepLinks,
      pantryItems: pantry,
      groceryLists: lists,
      groceryLines: lines,
      agentActivity: activity,
    };
  });
}

/**
 * Deletes everything, for real.
 *
 * The domain tables carry no foreign key to `user`, because the two migrators
 * run in sequence and Drizzle's runs first, so nothing cascades on its own.
 * That is written down in docs/02-data-model.md as a cost to be paid here, and
 * this is where it is paid: children before parents, then the account itself,
 * which does cascade Better Auth's own tables and every live session.
 */
export async function deleteAccount(ctx: ServiceContext): Promise<void> {
  await withUser(ctx.userId, async (tx) => {
    await tx.delete(groceryLine).where(eq(groceryLine.userId, ctx.userId));
    await tx.delete(groceryList).where(eq(groceryList.userId, ctx.userId));
    await tx.delete(prepLink).where(eq(prepLink.userId, ctx.userId));
    await tx.delete(entryFeedback).where(eq(entryFeedback.userId, ctx.userId));
    await tx.delete(planEntry).where(eq(planEntry.userId, ctx.userId));
    await tx.delete(planVersion).where(eq(planVersion.userId, ctx.userId));
    await tx.delete(plan).where(eq(plan.userId, ctx.userId));
    await tx
      .delete(recipeIngredient)
      .where(eq(recipeIngredient.userId, ctx.userId));
    await tx.delete(recipeStep).where(eq(recipeStep.userId, ctx.userId));
    await tx.delete(recipeRevision).where(eq(recipeRevision.userId, ctx.userId));
    await tx.delete(recipe).where(eq(recipe.userId, ctx.userId));
    await tx.delete(pantryItem).where(eq(pantryItem.userId, ctx.userId));
    await tx.delete(slotConfig).where(eq(slotConfig.userId, ctx.userId));
    await tx.delete(mealType).where(eq(mealType.userId, ctx.userId));
    await tx.delete(ingredient).where(eq(ingredient.userId, ctx.userId));
    await tx.delete(fact).where(eq(fact.userId, ctx.userId));
    await tx.delete(allergen).where(eq(allergen.userId, ctx.userId));
    await tx.delete(exclusion).where(eq(exclusion.userId, ctx.userId));
    await tx.delete(equipment).where(eq(equipment.userId, ctx.userId));
    await tx.delete(agentActivity).where(eq(agentActivity.userId, ctx.userId));
    await tx.delete(profile).where(eq(profile.userId, ctx.userId));
  });

  // Better Auth owns this row and its foreign keys, so removing it takes the
  // sessions, the OAuth clients and the consents with it.
  await db.execute(sql`delete from "user" where id = ${ctx.userId}`);
}
