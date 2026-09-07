import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { importRecipeFromUrl } from "@/services/import-service";
import type { McpCallerContext } from "../server";
import { toolJson } from "../serializers";
import { runTool } from "../tool-runner";

/**
 * The two-tier import, from the agent's side.
 *
 * The description spends most of its length on what to do when it fails,
 * because that is the branch that matters: the fallback is the agent fetching
 * the page itself, and an agent that does not know it is expected to do that
 * will just report failure to the user.
 */
export function registerImportRecipe(
  server: McpServer,
  caller: McpCallerContext,
): void {
  server.registerTool(
    "import_recipe_from_url",
    {
      title: "Importer une recette depuis une adresse",
      description:
        "Lit une page de recette côté serveur et en extrait les données " +
        "structurées (schema.org Recipe), puis crée la recette. La plupart des " +
        "sites de cuisine les publient.\n\n" +
        "Si la page n'en publie pas, l'appel échoue avec une erreur explicite " +
        "et rien n'est deviné. Dans ce cas, faites-le vous-même : récupérez la " +
        "page, lisez-la, et appelez `create_recipe` avec les ingrédients et les " +
        "étapes. C'est le chemin prévu, pas un contournement, et c'est ce qui " +
        "remplace ici l'intelligence côté serveur.\n\n" +
        "Seules les adresses http et https publiques sont lues.",
      inputSchema: {
        // `z.url()` rather than a bare string: the format lands in the JSON
        // Schema an agent reads, and a malformed address is refused at the edge
        // instead of travelling into the fetch layer to be rejected there.
        url: z
          .url()
          .max(2000)
          .describe("Adresse complète de la recette, en http ou https."),
      },
    },
    async (args) =>
      runTool(
        caller,
        {
          name: "import_recipe_from_url",
          direction: "write",
          requiredScopes: ["recipes:write"],
          payloadSummary: { url: args.url },
          // It fetches a third-party page before it writes. Wrapping that in the
          // audit transaction would hold a database transaction open across the
          // fetch, so this one tool logs after the commit. See ToolOptions.
          transactional: false,
        },
        async (ctx) => {
          const created = await importRecipeFromUrl(ctx, args.url);
          return toolJson({
            id: created.recipe.id,
            title: created.recipe.title,
            source_url: created.recipe.sourceUrl,
            ingredients: created.ingredients.length,
            steps: created.steps.length,
            note: "Le temps de cuisine active n'est jamais publié par les sites : demandez-le à l'utilisateur ou laissez-le vide plutôt que de l'inventer, c'est lui que contraignent les budgets de créneau.",
          });
        },
      ),
  );
}
