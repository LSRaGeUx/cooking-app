import { eq, sql } from "drizzle-orm";
import {
  agentActivity,
  allergen,
  entryFeedback,
  equipment,
  exclusion,
  fact,
  groceryLine,
  groceryList,
  groceryListVersion,
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
import { inScope, type ServiceContext } from "./context";
import { forgetUserSetup } from "./onboarding-service";

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
  // `inScope` rather than `withUser` directly, so an export composed inside
  // another service's transaction joins it instead of opening a second one.
  // This was the one service that ignored `ctx.tx`.
  return inScope(ctx, async ({ tx }) => {
    // Every select carries the `user_id` predicate. Row-level security is the
    // second pair of eyes this file's own comment claimed it was, and it was
    // the only one: twenty-one unscoped selects relied entirely on the policy,
    // which is the arrangement rule 8 exists to forbid.
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
      listVersions,
      lines,
      activity,
    ] = [
      await tx.select().from(profile).where(eq(profile.userId, ctx.userId)),
      await tx.select().from(allergen).where(eq(allergen.userId, ctx.userId)),
      await tx.select().from(exclusion).where(eq(exclusion.userId, ctx.userId)),
      await tx.select().from(equipment).where(eq(equipment.userId, ctx.userId)),
      await tx.select().from(fact).where(eq(fact.userId, ctx.userId)),
      await tx.select().from(mealType).where(eq(mealType.userId, ctx.userId)),
      await tx
        .select()
        .from(slotConfig)
        .where(eq(slotConfig.userId, ctx.userId)),
      await tx
        .select()
        .from(ingredient)
        .where(eq(ingredient.userId, ctx.userId)),
      await tx.select().from(recipe).where(eq(recipe.userId, ctx.userId)),
      await tx
        .select()
        .from(recipeIngredient)
        .where(eq(recipeIngredient.userId, ctx.userId)),
      await tx
        .select()
        .from(recipeStep)
        .where(eq(recipeStep.userId, ctx.userId)),
      await tx
        .select()
        .from(recipeRevision)
        .where(eq(recipeRevision.userId, ctx.userId)),
      await tx.select().from(plan).where(eq(plan.userId, ctx.userId)),
      await tx
        .select()
        .from(planVersion)
        .where(eq(planVersion.userId, ctx.userId)),
      await tx.select().from(planEntry).where(eq(planEntry.userId, ctx.userId)),
      await tx
        .select()
        .from(entryFeedback)
        .where(eq(entryFeedback.userId, ctx.userId)),
      await tx.select().from(prepLink).where(eq(prepLink.userId, ctx.userId)),
      await tx
        .select()
        .from(pantryItem)
        .where(eq(pantryItem.userId, ctx.userId)),
      await tx
        .select()
        .from(groceryList)
        .where(eq(groceryList.userId, ctx.userId)),
      await tx
        .select()
        .from(groceryListVersion)
        .where(eq(groceryListVersion.userId, ctx.userId)),
      await tx
        .select()
        .from(groceryLine)
        .where(eq(groceryLine.userId, ctx.userId)),
      await tx
        .select()
        .from(agentActivity)
        .where(eq(agentActivity.userId, ctx.userId)),
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
      // Which plan versions each list was built from. It was missing, so an
      // export promising "everything, in one file" could not say what any
      // grocery list had been generated against.
      groceryListVersions: listVersions,
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
 *
 * All of it in one transaction, the `user` row included. It used to commit the
 * domain deletes and then issue the `user` delete on the pool afterwards, so a
 * failure in that last statement left an account that could still sign in with
 * every one of its recipes, plans and facts gone, and which then re-seeded a
 * starter grid on the next request. It is the same database, so there is
 * nothing to gain by leaving it outside.
 */
export async function deleteAccount(ctx: ServiceContext): Promise<void> {
  await inScope(ctx, async ({ tx }) => {
    await tx.delete(groceryLine).where(eq(groceryLine.userId, ctx.userId));
    await tx
      .delete(groceryListVersion)
      .where(eq(groceryListVersion.userId, ctx.userId));
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
    await tx
      .delete(recipeRevision)
      .where(eq(recipeRevision.userId, ctx.userId));
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

    // Better Auth owns this row and its foreign keys, so removing it takes the
    // sessions, the OAuth clients and the consents with it. Raw SQL because
    // that table is outside the Drizzle schema, on the same connection because
    // it is the same database and the same unit of work.
    await tx.execute(sql`delete from "user" where id = ${ctx.userId}`);
  });

  // The setup memo in onboarding-service would otherwise keep claiming this
  // user is seeded, for the life of the process.
  forgetUserSetup(ctx.userId);
}
