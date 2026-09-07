import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { recipeInputSchema } from "@/domain/schemas";
import { createRecipe, updateRecipe } from "@/services/recipe-service";
import { recipeParamsSchema, toRecipeInput } from "../schemas";
import type { McpCallerContext } from "../server";
import { toolJson } from "../serializers";
import { runTool } from "../tool-runner";

/**
 * Writing recipes.
 *
 * Both descriptions point back at `propose_week` for the common case, because
 * an agent planning a week of new dishes should not make eight create calls and
 * a ninth to assign them: that is exactly the partial-failure shape the atomic
 * payload exists to avoid.
 */

/**
 * `update_recipe` used to mix the two conventions inside one object:
 * `recipe_id` next to `activeTimeMin`, because the id was declared here and
 * everything else was spread from the domain schema. Both halves are snake_case
 * now, and the mapping to the domain shape happens in the handler.
 */
const updateRecipeParamsSchema = recipeParamsSchema.extend({
  recipe_id: z.uuid().describe("Identifiant de la recette à remplacer."),
});

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
        "pas par ici : mettez-la dans `new_recipes` de `propose_week`, qui crée " +
        "et assigne en une transaction. Cet outil est pour enrichir la " +
        "bibliothèque sans planifier.\n\n" +
        "Renseignez `active_time_min` avec soin : c'est le temps de présence " +
        "réelle en cuisine, et c'est lui, pas le temps total, que les budgets " +
        "de créneau contraignent.",
      inputSchema: recipeParamsSchema.shape,
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
          const input = recipeInputSchema.parse(
            toRecipeInput(recipeParamsSchema.parse(args)),
          );
          const created = await createRecipe(ctx, input);
          return toolJson({
            id: created.recipe.id,
            title: created.recipe.title,
            revision: created.recipe.revision,
            ingredients: created.ingredients.length,
            linked_ingredients: created.ingredients.filter(
              (line) => line.ingredientId !== null,
            ).length,
          });
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
      inputSchema: updateRecipeParamsSchema.shape,
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
          const params = updateRecipeParamsSchema.parse(args);
          const input = recipeInputSchema.parse(toRecipeInput(params));
          const updated = await updateRecipe(ctx, params.recipe_id, input);
          return toolJson({
            id: updated.recipe.id,
            title: updated.recipe.title,
            revision: updated.recipe.revision,
          });
        },
      ),
  );
}
