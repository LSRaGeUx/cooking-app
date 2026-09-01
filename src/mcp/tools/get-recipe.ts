import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getRecipe } from "@/services/recipe-service";
import type { McpCallerContext } from "../server";
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
        async (ctx) => {
          const detail = await getRecipe(ctx, recipe_id);
          return JSON.stringify(
            {
              id: detail.recipe.id,
              title: detail.recipe.title,
              description: detail.recipe.description,
              servings: detail.recipe.servings,
              prep_time_min: detail.recipe.prepTimeMin,
              cook_time_min: detail.recipe.cookTimeMin,
              active_time_min: detail.recipe.activeTimeMin,
              batch_friendly: detail.recipe.batchFriendly,
              keeps_days: detail.recipe.keepsDays,
              tags: detail.recipe.tags,
              cuisine: detail.recipe.cuisine,
              main_protein: detail.recipe.mainProtein,
              equipment_keys: detail.recipe.equipmentKeys,
              revision: detail.recipe.revision,
              // A soft-deleted recipe is still readable so history stays
              // explicable, but it must not be proposed.
              deleted: detail.recipe.deletedAt !== null,
              ingredients: detail.ingredients.map((line) => ({
                quantity: line.quantity,
                unit: line.unit,
                name: line.rawName,
                normalized_name: line.canonicalName,
                note: line.note,
                optional: line.optional,
              })),
              steps: detail.steps.map((step) => ({
                text: step.text,
                duration_min: step.durationMin,
                unattended: step.unattended,
              })),
            },
            null,
            2,
          );
        },
      ),
  );
}
