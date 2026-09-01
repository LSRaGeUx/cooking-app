import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DomainError } from "@/domain/errors";
import { currentIsoWeek } from "@/domain/week";
import {
  getVersionEntries,
  getWeekView,
  listVersions,
} from "@/services/plan-service";
import type { McpCallerContext } from "../server";
import { runTool } from "../tool-runner";

/**
 * Reading a planned week.
 *
 * The version parameter exists because a plan is a stack of immutable versions,
 * not a mutable document. An agent that wants to know what the user actually
 * intends reads `active`; one that wants to rebase after a conflict reads a
 * specific number.
 */
export function registerGetWeek(
  server: McpServer,
  caller: McpCallerContext,
): void {
  server.registerTool(
    "get_week",
    {
      title: "Lire une semaine planifiée",
      description:
        "Renvoie les repas planifiés d'une semaine ISO, avec les créneaux tels " +
        "qu'ils étaient configurés, les portions, les notes et la justification " +
        "de chaque entrée écrite par un agent. Une semaine sans plan renvoie une " +
        "grille vide et planifiable, ce qui n'est pas une erreur. Précisez " +
        "toujours l'année : un numéro de semaine seul est ambigu au passage " +
        "d'une année à l'autre.",
      inputSchema: {
        year: z
          .number()
          .int()
          .min(1970)
          .max(9999)
          .optional()
          .describe("Année de numérotation ISO. Par défaut, la semaine en cours."),
        week: z
          .number()
          .int()
          .min(1)
          .max(53)
          .optional()
          .describe("Numéro de semaine ISO. Par défaut, la semaine en cours."),
        version: z
          .union([z.literal("active"), z.literal("pending"), z.number().int().min(1)])
          .default("active")
          .describe(
            "`active` pour le plan qui fait foi, `pending` pour une proposition " +
              "en attente de validation, ou un numéro de version précis.",
          ),
      },
    },
    async ({ year, week, version }) =>
      runTool(
        caller,
        {
          name: "get_week",
          direction: "read",
          requiredScopes: ["plan:read"],
          payloadSummary: { year, week, version },
        },
        async (ctx) => {
          const target =
            year !== undefined && week !== undefined
              ? { year, week }
              : currentIsoWeek();

          const view = await getWeekView(ctx, target);
          const versions = await listVersions(ctx, target);

          const chosen =
            version === "active"
              ? view.activeVersion
              : version === "pending"
                ? view.pendingVersion
                : (versions.find((row) => row.versionNumber === version) ?? null);

          if (typeof version === "number" && chosen === null) {
            throw new DomainError(
              "NOT_FOUND",
              `La version ${version} n'existe pas pour ${target.year}-W${target.week}. Versions disponibles : ${versions.map((row) => row.versionNumber).join(", ") || "aucune"}.`,
              {
                requested: version,
                available: versions.map((row) => row.versionNumber),
              },
            );
          }

          const entries =
            chosen === null
              ? []
              : chosen.id === view.activeVersion?.id
                ? view.entries
                : await getVersionEntries(ctx, chosen.id);

          return JSON.stringify(
            {
              year: target.year,
              week: target.week,
              version:
                chosen === null
                  ? null
                  : {
                      number: chosen.versionNumber,
                      state: chosen.state,
                      created_by: chosen.createdBy,
                      summary: chosen.summary,
                    },
              // The token an agent hands back to a write call so a concurrent
              // edit cannot be silently overwritten.
              expected_base_version: view.activeVersion?.versionNumber ?? null,
              slots: view.slots.map((slot) => ({
                day_of_week: slot.dayOfWeek,
                meal_type_id: slot.mealTypeId,
                meal_type_key: slot.mealTypeKey,
                meal_type_label: slot.mealTypeLabel,
                state: slot.state,
                time_budget_min: slot.timeBudgetMin,
                default_servings: slot.defaultServings,
              })),
              entries: entries.map((entry) => ({
                id: entry.id,
                day_of_week: entry.dayOfWeek,
                meal_type_id: entry.mealTypeId,
                recipe_id: entry.recipeId,
                recipe_title: entry.recipeTitleSnapshot,
                servings: entry.servings,
                note: entry.note,
                rationale: entry.rationale,
              })),
              // Entries whose slot is no longer planned. Kept, never dropped.
              orphaned_entries: view.orphanedEntries.map((entry) => ({
                id: entry.id,
                day_of_week: entry.dayOfWeek,
                recipe_title: entry.recipeTitleSnapshot,
              })),
              versions: versions.map((row) => ({
                number: row.versionNumber,
                state: row.state,
                created_by: row.createdBy,
              })),
            },
            null,
            2,
          );
        },
      ),
  );
}
