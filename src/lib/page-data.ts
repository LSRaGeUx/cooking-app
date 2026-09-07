import { cache } from "react";
import { notFound } from "next/navigation";
import { isDomainError } from "@/domain/errors";
import { getProfile } from "@/services/profile-service";
import { getRecipe, type RecipeDetail } from "@/services/recipe-service";
import type { ServiceContext } from "@/services/context";

/**
 * The reads more than one page of the application makes, memoized per request
 * or wrapped once each, rather than repeated.
 *
 * `requireUser` in src/lib/session.ts is already wrapped in React's `cache` for
 * exactly this reason. These are the other two.
 */

/**
 * The profile, once per request.
 *
 * `src/app/(app)/layout.tsx` reads it to work out which shopping cycle the bar
 * should point at, and the week screen, the shopping screen and the profile
 * screen each read it again. That was two queries per request on every one of
 * those pages, for a row that cannot change between them.
 *
 * `cache` keys on the argument, and the `ServiceContext` handed round a request
 * comes from `requireUser`, which is itself cached and so returns the same
 * object every time. So the memo hits.
 */
export const loadProfile = cache(async (ctx: ServiceContext) =>
  getProfile(ctx),
);

/**
 * A recipe, or a 404.
 *
 * The detail page and the edit page carried the same six-line try/catch
 * turning `RECIPE_NOT_FOUND` into `notFound()`. Anything that is not that code
 * is rethrown, so a real failure reaches the error boundary rather than being
 * reported to the reader as a missing recipe.
 */
export async function loadRecipeOr404(
  ctx: ServiceContext,
  recipeId: string,
): Promise<RecipeDetail> {
  try {
    return await getRecipe(ctx, recipeId);
  } catch (error) {
    if (isDomainError(error) && error.code === "RECIPE_NOT_FOUND") notFound();
    throw error;
  }
}
