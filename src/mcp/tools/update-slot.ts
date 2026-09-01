import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DomainError } from "@/domain/errors";
import { assignRecipe, clearSlot } from "@/services/plan-service";
import { listMealTypes } from "@/services/slot-service";
import type { McpCallerContext } from "../server";
import { runTool } from "../tool-runner";

/**
 * One slot at a time, for the "actually, swap Tuesday" case.
 *
 * It creates a new version under the hood like every other edit. That is worth
 * saying in the description, because an agent that believes it is patching a
 * mutable document will reason wrongly about concurrency.
 */
export function registerUpdateSlot(
  server: McpServer,
  caller: McpCallerContext,
): void {
  server.registerTool(
    "update_slot",
    {
      title: "Modifier un créneau",
      description:
        "Change ou vide un seul créneau de la semaine active. Utile pour " +
        "corriger une proposition déjà acceptée sans tout reproposer.\n\n" +
        "Comme toute modification, cet appel crée une nouvelle version du plan : " +
        "rien n'est modifié sur place, et l'utilisateur peut revenir en arrière. " +
        "La version précédente devient « remplacée ».\n\n" +
        "Une justification est exigée quand vous placez une recette, comme pour " +
        "`propose_week`.",
      inputSchema: {
        year: z.number().int().min(1970).max(9999),
        week: z.number().int().min(1).max(53),
        day_of_week: z.number().int().min(1).max(7),
        meal_type: z
          .string()
          .min(1)
          .max(40)
          .describe("Clé du type de repas, par exemple `dinner`."),
        recipe_id: z
          .uuid()
          .nullable()
          .default(null)
          .describe(
            "Recette à placer. `null` vide le créneau, ce qui n'exige pas de justification.",
          ),
        servings: z.number().int().min(1).max(50).nullable().default(null),
        note: z.string().max(500).nullable().default(null),
        rationale: z
          .string()
          .max(1000)
          .nullable()
          .default(null)
          .describe(
            "Obligatoire pour placer une recette : pourquoi ce plat, à ce créneau, pour cette personne.",
          ),
        rationale_refs: z.array(z.string().min(1).max(100)).max(20).default([]),
      },
    },
    async (args) =>
      runTool(
        caller,
        {
          name: "update_slot",
          direction: "write",
          requiredScopes: ["plan:write"],
          payloadSummary: {
            week: `${args.year}-W${args.week}`,
            day: args.day_of_week,
            mealType: args.meal_type,
            clearing: args.recipe_id === null,
          },
        },
        async (ctx) => {
          const week = { year: args.year, week: args.week };
          const mealTypes = await listMealTypes(ctx);
          const mealType = mealTypes.find((type) => type.key === args.meal_type);
          if (!mealType) {
            throw new DomainError(
              "SLOT_UNKNOWN",
              `Aucun type de repas ne porte la clé « ${args.meal_type} ». Clés valides : ${mealTypes.map((type) => type.key).join(", ")}.`,
              {
                received: args.meal_type,
                valid: mealTypes.map((type) => type.key),
              },
            );
          }

          const result =
            args.recipe_id === null
              ? await clearSlot(ctx, week, {
                  dayOfWeek: args.day_of_week,
                  mealTypeId: mealType.id,
                })
              : await assignRecipe(ctx, week, {
                  dayOfWeek: args.day_of_week,
                  mealTypeId: mealType.id,
                  recipeId: args.recipe_id,
                  servings: args.servings,
                  note: args.note,
                  rationale: args.rationale,
                  rationaleRefs: args.rationale_refs,
                });

          return JSON.stringify(
            {
              version_number: result.version.versionNumber,
              state: result.version.state,
              entries: result.entries.length,
              warnings: result.warnings.map((warning) => ({
                code: warning.code,
                message: warning.message,
              })),
            },
            null,
            2,
          );
        },
      ),
  );
}
