import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { recipeInputSchema } from "@/domain/schemas";
import { createRecipe, updateRecipe } from "@/services/recipe-service";
import type { McpCallerContext } from "../server";
import { runTool } from "../tool-runner";

/**
 * Writing recipes.
 *
 * Both descriptions point back at `propose_week` for the common case, because
 * an agent planning a week of new dishes should not make eight create calls and
 * a ninth to assign them: that is exactly the partial-failure shape the atomic
 * payload exists to avoid.
 */
export function registerRecipeWrites(
  server: McpServer,
  caller: McpCallerContext,
): void {
  server.registerTool(
    "create_recipe",
    {
      title: "Créer une recette",
      description:
        "Ajoute une recette à la bibliothèque, marquée comme écrite par un " +
        "agent et modifiable par l'utilisateur.\n\n" +
        "Si vous créez une recette pour la planifier dans la foulée, ne passez " +
        "pas par ici : mettez-la dans `newRecipes` de `propose_week`, qui crée " +
        "et assigne en une transaction. Cet outil est pour enrichir la " +
        "bibliothèque sans planifier.\n\n" +
        "Renseignez `activeTimeMin` avec soin : c'est le temps de présence " +
        "réelle en cuisine, et c'est lui, pas le temps total, que les budgets " +
        "de créneau contraignent.",
      inputSchema: recipeInputSchema.shape,
    },
    async (args) =>
      runTool(
        caller,
        {
          name: "create_recipe",
          direction: "write",
          requiredScopes: ["recipes:write"],
          payloadSummary: { title: args.title },
        },
        async (ctx) => {
          const created = await createRecipe(ctx, args);
          return JSON.stringify(
            {
              id: created.recipe.id,
              title: created.recipe.title,
              revision: created.recipe.revision,
              ingredients: created.ingredients.length,
              linked_ingredients: created.ingredients.filter(
                (line) => line.ingredientId !== null,
              ).length,
            },
            null,
            2,
          );
        },
      ),
  );

  server.registerTool(
    "update_recipe",
    {
      title: "Modifier une recette",
      description:
        "Remplace le contenu d'une recette existante. La version précédente est " +
        "conservée et le numéro de révision augmente, donc l'utilisateur peut " +
        "voir ce qui a changé et une semaine déjà planifiée reste explicable.\n\n" +
        "L'appel remplace la recette entière : envoyez tous les ingrédients et " +
        "toutes les étapes, pas seulement ceux qui changent.",
      inputSchema: {
        recipe_id: z.uuid(),
        ...recipeInputSchema.shape,
      },
    },
    async (args) =>
      runTool(
        caller,
        {
          name: "update_recipe",
          direction: "write",
          requiredScopes: ["recipes:write"],
          payloadSummary: { recipeId: args.recipe_id, title: args.title },
        },
        async (ctx) => {
          const { recipe_id: recipeId, ...input } = args;
          const updated = await updateRecipe(ctx, recipeId, input);
          return JSON.stringify(
            {
              id: updated.recipe.id,
              title: updated.recipe.title,
              revision: updated.recipe.revision,
            },
            null,
            2,
          );
        },
      ),
  );
}
