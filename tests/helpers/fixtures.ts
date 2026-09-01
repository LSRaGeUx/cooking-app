import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { withUser } from "@/db/client";
import {
  agentActivity,
  allergen,
  equipment,
  exclusion,
  fact,
  groceryLine,
  groceryList,
  ingredient,
  mealType,
  plan,
  planEntry,
  planVersion,
  profile,
  recipe,
  recipeIngredient,
  recipeRevision,
  recipeStep,
  slotConfig,
} from "@/db/schema";
import { userContext, type ServiceContext } from "@/services/context";

/**
 * Service tests run against the real Postgres from compose.yaml, connected as
 * the non-owner role. Row-level security, check constraints, partial unique
 * indexes and the generated search vector are exactly the kind of rule a mock
 * would happily pretend to enforce, and three of them are load-bearing.
 *
 * The user id is a bare uuid rather than a real Better Auth user: the domain
 * tables carry no foreign key to that table, because the two migrators run in
 * sequence and Drizzle's runs first.
 */
export function testUser(): ServiceContext {
  return userContext(randomUUID());
}

/** Deletes everything a test user owns, children before parents. */
export async function cleanupUser(ctx: ServiceContext): Promise<void> {
  await withUser(ctx.userId, async (tx) => {
    await tx.delete(groceryLine).where(eq(groceryLine.userId, ctx.userId));
    await tx.delete(groceryList).where(eq(groceryList.userId, ctx.userId));
    await tx.delete(planEntry).where(eq(planEntry.userId, ctx.userId));
    await tx.delete(planVersion).where(eq(planVersion.userId, ctx.userId));
    await tx.delete(plan).where(eq(plan.userId, ctx.userId));
    await tx
      .delete(recipeIngredient)
      .where(eq(recipeIngredient.userId, ctx.userId));
    await tx.delete(recipeStep).where(eq(recipeStep.userId, ctx.userId));
    await tx.delete(recipeRevision).where(eq(recipeRevision.userId, ctx.userId));
    await tx.delete(recipe).where(eq(recipe.userId, ctx.userId));
    await tx.delete(slotConfig).where(eq(slotConfig.userId, ctx.userId));
    await tx.delete(mealType).where(eq(mealType.userId, ctx.userId));
    await tx.delete(ingredient).where(eq(ingredient.userId, ctx.userId));
    await tx.delete(allergen).where(eq(allergen.userId, ctx.userId));
    await tx.delete(exclusion).where(eq(exclusion.userId, ctx.userId));
    await tx.delete(equipment).where(eq(equipment.userId, ctx.userId));
    await tx.delete(fact).where(eq(fact.userId, ctx.userId));
    await tx.delete(profile).where(eq(profile.userId, ctx.userId));
    await tx.delete(agentActivity).where(eq(agentActivity.userId, ctx.userId));
  });
}
