"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  parseIngredientBlock,
  type ParsedIngredientLine,
} from "@/domain/ingredient-parser";
import { requireUser } from "@/lib/session";
import { importRecipeFromUrl } from "@/services/import-service";
import {
  createRecipe,
  restoreRecipe,
  searchRecipes,
  softDeleteRecipe,
  updateRecipe,
  type RecipeDetail,
  type RecipeSearchResult,
} from "@/services/recipe-service";
import { runAction, type ActionResult } from "./result";

const recipeIdSchema = z.uuid();

/**
 * Both write paths revalidate the library and the detail page. They used to
 * disagree: a delete revalidated only `/recettes`, so the detail page kept
 * rendering without the "deleted" chip that is the only sign the recipe is on
 * its way out.
 */
function revalidateRecipe(recipeId: string): void {
  revalidatePath("/recettes");
  revalidatePath(`/recettes/${recipeId}`);
}

export async function createRecipeAction(
  input: unknown,
): Promise<ActionResult<RecipeDetail>> {
  const { ctx } = await requireUser();
  return runAction(async () => {
    const detail = await createRecipe(ctx, input);
    revalidateRecipe(detail.recipe.id);
    return detail;
  });
}

export async function updateRecipeAction(
  recipeId: string,
  input: unknown,
): Promise<ActionResult<RecipeDetail>> {
  const { ctx } = await requireUser();
  return runAction(async () => {
    const id = recipeIdSchema.parse(recipeId);
    const detail = await updateRecipe(ctx, id, input);
    revalidateRecipe(id);
    return detail;
  });
}

/**
 * Soft delete, with a 30-day window. `restoreRecipeAction` below is the other
 * half of that promise (CLAUDE.md rule 5): a delete the user cannot undo is
 * not a soft delete, it is a slow one.
 */
export async function deleteRecipeAction(
  recipeId: string,
): Promise<ActionResult<void>> {
  const { ctx } = await requireUser();
  return runAction(async () => {
    const id = recipeIdSchema.parse(recipeId);
    await softDeleteRecipe(ctx, id);
    revalidateRecipe(id);
  });
}

export async function restoreRecipeAction(
  recipeId: string,
): Promise<ActionResult<void>> {
  const { ctx } = await requireUser();
  return runAction(async () => {
    const id = recipeIdSchema.parse(recipeId);
    await restoreRecipe(ctx, id);
    revalidateRecipe(id);
  });
}

/**
 * The user-facing half of the two-tier import. A refusal is shown as it comes
 * from the service, which already says what to do next.
 *
 * `fallbackTitle` is what an imported page gets when it publishes no name of
 * its own. It arrives from the screen because it is UI copy: the import service
 * used to carry a French literal for it, which is a user-facing string outside
 * next-intl on the server side of the application.
 */
export async function importRecipeAction(
  url: string,
  fallbackTitle: string,
): Promise<ActionResult<RecipeDetail>> {
  const { ctx } = await requireUser();
  return runAction(async () => {
    const detail = await importRecipeFromUrl(ctx, importUrlSchema.parse(url), {
      fallbackTitle: titleSchema.parse(fallbackTitle),
    });
    revalidateRecipe(detail.recipe.id);
    return detail;
  });
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
 *
 * The block is capped before it is parsed. It was unbounded, and the parser
 * splits on lines and runs several regular expressions per line, so a megabyte
 * of text pasted into that box was a CPU-bound request on a single-user box.
 * 200 lines of 200 characters is more than any recipe has.
 */
export async function parseIngredientsAction(
  block: string,
): Promise<ActionResult<ParsedIngredientLine[]>> {
  await requireUser();
  return runAction(async () => parseIngredientBlock(blockSchema.parse(block)));
}

const blockSchema = z.string().max(40_000);

/**
 * The same bound `recipeInputSchema.imageUrl` puts on a stored address. The
 * https check is the import service's own, because it also decides what it is
 * willing to fetch.
 */
const importUrlSchema = z.string().max(2000);

/** The same bound `recipeInputSchema.title` puts on a stored title. */
const titleSchema = z.string().min(1).max(200);
