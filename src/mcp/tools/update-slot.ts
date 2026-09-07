import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DomainError } from "@/domain/errors";
import { formatIsoWeek } from "@/domain/week";
import { assignRecipe, clearSlot } from "@/services/plan-service";
import { listMealTypes } from "@/services/slot-service";
import type { McpCallerContext } from "../server";
import { serializeWarning, toolJson } from "../serializers";
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
        year: z
          .number()
          .int()
          .min(1970)
          .max(9999)
          .describe(
            "Année de numérotation ISO, jamais l'année civile supposée.",
          ),
        week: z
          .number()
          .int()
          .min(1)
          .max(53)
          .describe("Numéro de semaine ISO."),
        day_of_week: z
          .number()
          .int()
          .min(1)
          .max(7)
          .describe("Jour ISO : 1 = lundi, 7 = dimanche."),
        meal_type: z
          .string()
          .min(1)
          .max(40)
          .describe(
            "Clé du type de repas, par exemple `dinner`. Les clés valides sont dans la ressource `cooking://slots`.",
          ),
        recipe_id: z
          .uuid()
          .nullable()
          .default(null)
          .describe(
            "Recette à placer. `null` vide le créneau, ce qui n'exige pas de justification.",
          ),
        servings: z
          .number()
          .int()
          .min(1)
          .max(50)
          .nullable()
          .default(null)
          .describe(
            "Portions pour ce repas, ou `null` pour reprendre celles du créneau puis celles du profil.",
          ),
        note: z
          .string()
          .max(500)
          .nullable()
          .default(null)
          .describe("Note libre affichée avec le repas."),
        rationale: z
          .string()
          .max(1000)
          .nullable()
          .default(null)
          .describe(
            "Obligatoire pour placer une recette : pourquoi ce plat, à ce créneau, pour cette personne.",
          ),
        rationale_refs: z
          .array(z.string().min(1).max(100))
          .max(20)
          .default([])
          .describe(
            "Identifiants des faits, retours ou produits de placard cités dans la justification.",
          ),
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
            week: formatIsoWeek({ year: args.year, week: args.week }),
            day: args.day_of_week,
            mealType: args.meal_type,
            clearing: args.recipe_id === null,
          },
        },
        async (ctx) => {
          const week = { year: args.year, week: args.week };

          // **Duplicated rule, pending a service that takes the key.**
          //
          // Resolving a meal-type key to its id, and raising SLOT_UNKNOWN when
          // there is no such key, is a business rule and it lives here, in the
          // MCP tool, which means the web path never runs it (CLAUDE.md rule 3).
          // `assignRecipe` and `clearSlot` still take a `mealTypeId`, so the
          // lookup cannot move yet: it belongs in the service, which was to grow
          // a `mealTypeKey` it resolves itself. When it does, delete this block
          // and pass the key straight through.
          //
          // Note also that this SLOT_UNKNOWN lists meal-type keys while the one
          // in the plan service lists plannable slots, and section 6 of
          // docs/03-agent-interface.md says the code names valid slots. Both
          // lists are correct for what they refuse, which is the argument for
          // one code per failure rather than one code for two.
          const mealTypes = await listMealTypes(ctx);
          const mealType = mealTypes.find(
            (type) => type.key === args.meal_type,
          );
          if (!mealType) {
            throw new DomainError(
              "SLOT_UNKNOWN",
              `Aucun type de repas ne porte la clé « ${args.meal_type} ». Clés valides : ${mealTypes.map((type) => type.key).join(", ") || "aucune"}. La ressource « cooking://slots » donne les créneaux planifiables avec ces clés.`,
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

          return toolJson({
            version_number: result.version.versionNumber,
            state: result.version.state,
            entries: result.entries.length,
            warnings: result.warnings.map(serializeWarning),
          });
        },
      ),
  );
}
