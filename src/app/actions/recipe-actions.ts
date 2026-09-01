"use server";

import { revalidatePath } from "next/cache";
import { parseIngredientBlock, type ParsedIngredientLine } from "@/domain/ingredient-parser";
import { requireUser } from "@/lib/session";
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
