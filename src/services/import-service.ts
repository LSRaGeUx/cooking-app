import { DomainError } from "@/domain/errors";
import { extractRecipe } from "@/domain/recipe-import";
import { safeFetch } from "@/lib/safe-fetch";
import type { ServiceContext } from "./context";
import { createRecipe, type RecipeDetail } from "./recipe-service";

/**
 * Importing a recipe from a URL.
 *
 * Tier one, here: fetch the page and read schema.org Recipe. Tier two is not
 * code at all, it is the shape of the failure. When nothing is found the caller
 * gets a specific, actionable refusal rather than a half-guessed recipe,
 * because an agent that is told "no structured recipe here, fetch the page
 * yourself and post it" will do exactly that, and a bad guess would have to be
 * corrected by hand instead.
 */
export async function importRecipeFromUrl(
  ctx: ServiceContext,
  url: string,
): Promise<RecipeDetail> {
  const response = await safeFetch(url, "recipe-import");

  if (response.status >= 400) {
    throw new DomainError(
      "VALIDATION",
      `Le site a répondu ${response.status}. Vérifiez l'adresse, ou récupérez la page vous-même et créez la recette avec \`create_recipe\`.`,
      { url, status: response.status },
    );
  }

  const outcome = extractRecipe(response.body, response.contentType);

  if (!outcome.ok) {
    throw new DomainError(
      "VALIDATION",
      `Cette page ne publie pas de recette structurée (schema.org Recipe), donc rien n'a pu en être lu de façon fiable. Plutôt que de deviner : récupérez la page vous-même, lisez-la, et créez la recette avec \`create_recipe\` en reprenant les ingrédients et les étapes. C'est le chemin prévu, pas un contournement.`,
      { url, reason: outcome.reason, parseFailed: true },
    );
  }

  // Stored through the ordinary create path, so ingredient linking, allergen
  // derivation and every other rule apply exactly as they do to a typed recipe.
  return createRecipe(ctx, outcome.recipe, {
    source: "import",
    sourceUrl: response.url,
  });
}
