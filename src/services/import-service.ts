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
export interface ImportOptions {
  /**
   * The title to use when the page publishes a Recipe with no name.
   *
   * It arrives from the caller rather than from the domain because it is UI
   * copy: `extractRecipe` returns a null title for that case on purpose, so the
   * placeholder lives in `messages/*.json` under `recipes.import.defaultTitle`
   * and the screen passes the reader's own language through. An agent calling
   * without one gets the French default below, which is the language every
   * other agent-facing string in this codebase is written in.
   */
  readonly fallbackTitle?: string;
}

export async function importRecipeFromUrl(
  ctx: ServiceContext,
  url: string,
  options: ImportOptions = {},
): Promise<RecipeDetail> {
  const response = await safeFetch(url, "recipe-import");

  // A 4xx and a 5xx call for opposite reactions, and both used to be reported
  // as `VALIDATION`, which tells an agent its own arguments were wrong. For a
  // server that is simply down that sends it hunting for a typo in an address
  // that was right, and it will hunt for ever.
  if (response.status >= 500) {
    throw new DomainError(
      "UPSTREAM_FAILED",
      `Le site a répondu ${response.status}, ce qui est une panne de son côté et non un problème d'adresse. L'appel était correct : réessayez plus tard à l'identique, ou récupérez la page vous-même et créez la recette avec \`create_recipe\`.`,
      { url, status: response.status, retryable: true },
    );
  }

  if (response.status >= 400) {
    throw new DomainError(
      "VALIDATION",
      `Le site a répondu ${response.status}, ce qui indique une adresse invalide, retirée ou protégée. Vérifiez l'adresse, ou récupérez la page vous-même et créez la recette avec \`create_recipe\`.`,
      { url, status: response.status },
    );
  }

  const outcome = extractRecipe(response.body, response.contentType);

  if (!outcome.ok) {
    // `PARSE_FAILED`, the code docs/03-agent-interface.md section 6 promises
    // for this case. It was `VALIDATION` with `details.parseFailed: true`,
    // which is the same information in a place an agent has no reason to look,
    // under a code that told it to rewrite a URL that was perfectly good.
    throw new DomainError(
      "PARSE_FAILED",
      `L'adresse a bien répondu, mais cette page ne publie pas de recette structurée (schema.org Recipe), donc rien n'a pu en être lu de façon fiable. L'adresse n'est pas en cause et la réécrire ne changera rien. Plutôt que de deviner : récupérez la page vous-même, lisez-la, et créez la recette avec \`create_recipe\` en reprenant les ingrédients et les étapes. C'est le chemin prévu, pas un contournement.`,
      { url, reason: outcome.reason, retryable: false },
    );
  }

  // Stored through the ordinary create path, so ingredient linking and every
  // other rule apply exactly as they do to a typed recipe. The title is the
  // only field this layer supplies, and only when the page published none.
  const fallback = options.fallbackTitle?.trim();
  return createRecipe(
    ctx,
    {
      ...outcome.recipe,
      // An empty or blank `fallbackTitle` falls through to the default rather
      // than reaching `recipeInputSchema`, whose `min(1)` would reject it with
      // a validation error about a field the caller did not fill in.
      title:
        outcome.recipe.title ??
        (fallback !== undefined && fallback.length > 0
          ? fallback
          : "Recette importée"),
    },
    { source: "import", sourceUrl: response.url },
  );
}
