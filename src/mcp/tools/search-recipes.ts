import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { recipeSearchSchema } from "@/domain/schemas";
import { searchRecipes } from "@/services/recipe-service";
import type { McpCallerContext } from "../server";
import { serializeRecipeListing, toolJson } from "../serializers";
import { runTool } from "../tool-runner";

/**
 * Finding something to cook.
 *
 * The filter that matters most is `not_cooked_in_weeks`: it is what turns
 * "propose me something" into "propose me something I have not had in a while",
 * which is the difference between a plausible week and a personal one.
 * `not_planned_in_weeks` is its sibling on intention rather than fact.
 */
const searchParamsSchema = z.object({
  query: z
    .string()
    .max(200)
    .optional()
    .describe(
      "Recherche plein texte. **Elle porte sur le titre et la description, et " +
        "sur rien d'autre** : chercher un nom d'ingrédient ne trouve rien, " +
        "parce que les ingrédients vivent dans une autre table et que l'index " +
        "de recherche est une colonne générée qui ne peut pas la lire. Pour " +
        "trouver un plat par ce qu'il contient, lisez « cooking://recipes/index » " +
        "puis `get_recipe` sur les candidats.",
    ),
  tags: z
    .array(z.string().min(1).max(40))
    .max(10)
    .optional()
    .describe(
      "Ne garde que les recettes portant au moins une de ces étiquettes.",
    ),
  max_active_time_min: z
    .number()
    .int()
    .min(0)
    .max(1440)
    .optional()
    .describe(
      "Temps de cuisine active maximum, en minutes. C'est ce temps, et non " +
        "le temps total, que le budget d'un créneau contraint : une heure de " +
        "four ne consomme pas la soirée.",
    ),
  main_protein: z
    .string()
    .max(60)
    .optional()
    .describe(
      "Protéine principale, telle qu'elle est écrite sur les recettes : " +
        "« poulet », « lentilles ». Utile pour équilibrer une semaine plutôt " +
        "que d'enchaîner trois plats de bœuf.",
    ),
  batch_friendly: z
    .boolean()
    .optional()
    .describe(
      "Ne garde que les recettes qui se doublent et se conservent, utiles " +
        "pour cuisiner une fois et manger deux fois.",
    ),
  not_planned_in_weeks: z
    .number()
    .int()
    .min(1)
    .max(104)
    .optional()
    .describe(
      "Exclut les recettes présentes dans un plan actif des N dernières " +
        "semaines. Attention à la nuance : ce filtre porte sur ce qui a été " +
        "planifié, pas sur ce qui a été réellement cuisiné. Pour les faits " +
        "plutôt que l'intention, utilisez `not_cooked_in_weeks`.",
    ),
  not_cooked_in_weeks: z
    .number()
    .int()
    .min(1)
    .max(104)
    .optional()
    .describe(
      "Exclut les recettes réellement cuisinées depuis moins de N " +
        "semaines, d'après les retours saisis. Une recette jamais " +
        "cuisinée passe le filtre. C'est le filtre à utiliser pour « quelque " +
        "chose que je n'ai pas mangé depuis longtemps » ; " +
        "`not_planned_in_weeks` porte sur l'intention, celui-ci sur les faits.",
    ),
  min_rating: z
    .number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .describe(
      "Note moyenne minimale. Une recette jamais notée est exclue : " +
        "l'absence de note n'est pas une bonne note.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe("Nombre de recettes à renvoyer, de 1 à 100. 20 par défaut."),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe(
      "Nombre de recettes à sauter, pour pager. `total` dans la réponse dit combien il y en a en tout.",
    ),
});

export function registerSearchRecipes(
  server: McpServer,
  caller: McpCallerContext,
): void {
  server.registerTool(
    "search_recipes",
    {
      title: "Chercher des recettes",
      description:
        "Cherche dans la bibliothèque de recettes de cette personne. Renvoie une " +
        "liste compacte, pas des recettes complètes : utilisez `get_recipe` pour " +
        "les ingrédients et les étapes d'une recette précise. Sans critère, " +
        "renvoie les recettes récemment modifiées. Pour parcourir toute la " +
        "bibliothèque d'un coup, lisez plutôt la ressource " +
        "`cooking://recipes/index`.\n\n" +
        "`query` ne cherche que dans le titre et la description, jamais dans les " +
        "ingrédients.",
      inputSchema: searchParamsSchema.shape,
    },
    async (args) =>
      runTool(
        caller,
        {
          name: "search_recipes",
          direction: "read",
          requiredScopes: ["recipes:read"],
          payloadSummary: {
            query: args.query,
            tags: args.tags,
            notPlannedInWeeks: args.not_planned_in_weeks,
            notCookedInWeeks: args.not_cooked_in_weeks,
          },
        },
        async (ctx) => {
          // Nine conditional spreads used to live here, and every one of them
          // existed only to rename a snake_case parameter to its camelCase
          // twin without introducing an explicit `undefined`. The domain schema
          // treats a missing key and an explicit `undefined` the same way, so
          // one mapping does the job the nine spreads were doing.
          const result = await searchRecipes(
            ctx,
            recipeSearchSchema.parse({
              query: args.query,
              tags: args.tags,
              maxActiveTimeMin: args.max_active_time_min,
              mainProtein: args.main_protein,
              batchFriendly: args.batch_friendly,
              notPlannedInWeeks: args.not_planned_in_weeks,
              notCookedInWeeks: args.not_cooked_in_weeks,
              minRating: args.min_rating,
              limit: args.limit,
              offset: args.offset,
            }),
          );

          return toolJson({
            total: result.total,
            returned: result.recipes.length,
            recipes: result.recipes.map(serializeRecipeListing),
          });
        },
      ),
  );
}
