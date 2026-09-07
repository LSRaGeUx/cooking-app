import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getRecipe } from "@/services/recipe-service";
import type { McpCallerContext } from "../server";
import { serializeRecipe, toolJson } from "../serializers";
import { runTool } from "../tool-runner";

export function registerGetRecipe(
  server: McpServer,
  caller: McpCallerContext,
): void {
  server.registerTool(
    "get_recipe",
    {
      title: "Lire une recette",
      description:
        "Renvoie une recette complète : ingrédients avec quantités, étapes, temps, " +
        "équipement requis. Utilisez `search_recipes` ou la ressource " +
        "`cooking://recipes/index` pour trouver un identifiant, puis n'appelez " +
        "ceci que pour les recettes que vous envisagez réellement : une recette " +
        "complète coûte bien plus de jetons qu'une ligne d'index.",
      inputSchema: {
        recipe_id: z.uuid().describe("Identifiant de la recette."),
      },
    },
    async ({ recipe_id }) =>
      runTool(
        caller,
        {
          name: "get_recipe",
          direction: "read",
          requiredScopes: ["recipes:read"],
          payloadSummary: { recipeId: recipe_id },
        },
        async (ctx) =>
          // The same serializer `cooking://recipes/{id}` uses, so the tool and
          // the resource answer with one shape.
          toolJson(serializeRecipe(await getRecipe(ctx, recipe_id))),
      ),
  );
}
