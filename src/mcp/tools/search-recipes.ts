import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { searchRecipes } from "@/services/recipe-service";
import type { McpCallerContext } from "../server";
import { runTool } from "../tool-runner";

/**
 * Finding something to cook.
 *
 * The filter that matters most is `not_planned_in_weeks`: it is what turns
 * "propose me something" into "propose me something I have not had in a while",
 * which is the difference between a plausible week and a personal one.
 */
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
        "`cooking://recipes/index`.",
      inputSchema: {
        query: z
          .string()
          .max(200)
          .optional()
          .describe("Recherche plein texte sur le titre et la description."),
        tags: z
          .array(z.string().min(1).max(40))
          .max(10)
          .optional()
          .describe("Ne garde que les recettes portant au moins une de ces étiquettes."),
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
        main_protein: z.string().max(60).optional(),
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
              "planifié, pas sur ce qui a été réellement cuisiné. Les retours après " +
              "cuisson n'existent pas encore dans cette version.",
          ),
        limit: z.number().int().min(1).max(100).default(20),
        offset: z.number().int().min(0).default(0),
      },
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
            tags: args.tags?.length,
            notPlannedInWeeks: args.not_planned_in_weeks,
          },
        },
        async (ctx) => {
          const result = await searchRecipes(ctx, {
            ...(args.query ? { query: args.query } : {}),
            ...(args.tags ? { tags: args.tags } : {}),
            ...(args.max_active_time_min !== undefined
              ? { maxActiveTimeMin: args.max_active_time_min }
              : {}),
            ...(args.main_protein ? { mainProtein: args.main_protein } : {}),
            ...(args.batch_friendly !== undefined
              ? { batchFriendly: args.batch_friendly }
              : {}),
            ...(args.not_planned_in_weeks !== undefined
              ? { notPlannedInWeeks: args.not_planned_in_weeks }
              : {}),
            limit: args.limit,
            offset: args.offset,
          });

          return JSON.stringify(
            {
              total: result.total,
              returned: result.recipes.length,
              recipes: result.recipes.map((row) => ({
                id: row.id,
                title: row.title,
                servings: row.servings,
                active_time_min: row.activeTimeMin,
                tags: row.tags,
                main_protein: row.mainProtein,
                cuisine: row.cuisine,
                batch_friendly: row.batchFriendly,
              })),
            },
            null,
            2,
          );
        },
      ),
  );
}
