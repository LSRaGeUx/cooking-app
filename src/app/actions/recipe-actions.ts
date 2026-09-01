"use server";

import { revalidatePath } from "next/cache";
import { parseIngredientBlock, type ParsedIngredientLine } from "@/domain/ingredient-parser";
import { requireUser } from "@/lib/session";
import { importRecipeFromUrl } from "@/services/import-service";
import {
  createRecipe,
  searchRecipes,
  softDeleteRecipe,
  updateRecipe,
  type RecipeDetail,
  type RecipeSearchResult,
} from "@/services/recipe-service";
import { runAction, type ActionResult } from "./result";

export async function createRecipeAction(
  input: unknown,
): Promise<ActionResult<RecipeDetail>> {
  const { ctx } = await requireUser();
  const result = await runAction(() => createRecipe(ctx, input));
  if (result.ok) revalidatePath("/recettes");
  return result;
}

export async function updateRecipeAction(
  recipeId: string,
  input: unknown,
): Promise<ActionResult<RecipeDetail>> {
  const { ctx } = await requireUser();
  const result = await runAction(() => updateRecipe(ctx, recipeId, input));
  if (result.ok) {
    revalidatePath("/recettes");
    revalidatePath(`/recettes/${recipeId}`);
  }
  return result;
}

export async function deleteRecipeAction(
  recipeId: string,
): Promise<ActionResult<void>> {
  const { ctx } = await requireUser();
  const result = await runAction(() => softDeleteRecipe(ctx, recipeId));
  if (result.ok) revalidatePath("/recettes");
  return result;
}

/**
 * The user-facing half of the two-tier import. A refusal is shown as it comes
 * from the service, which already says what to do next.
 */
export async function importRecipeAction(
  url: string,
): Promise<ActionResult<RecipeDetail>> {
  const { ctx } = await requireUser();
  const result = await runAction(() => importRecipeFromUrl(ctx, url));
  if (result.ok) revalidatePath("/recettes");
  return result;
}

export async function searchRecipesAction(
  input: unknown,
): Promise<ActionResult<RecipeSearchResult>> {
  const { ctx } = await requireUser();
  return runAction(() => searchRecipes(ctx, input));
}

/**
 * The paste parser runs on the server so the form and any future MCP caller
 * read the same implementation, and so the parser stays a pure domain function
 * with no bundling concerns.
 */
export async function parseIngredientsAction(
  block: string,
): Promise<ActionResult<ParsedIngredientLine[]>> {
  await requireUser();
  return runAction(async () => parseIngredientBlock(block));
}
