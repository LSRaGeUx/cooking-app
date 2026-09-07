import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DomainError } from "@/domain/errors";
import { currentIsoWeek, formatIsoWeek } from "@/domain/week";
import {
  getVersionEntries,
  getWeekView,
  listVersions,
} from "@/services/plan-service";
import type { McpCallerContext } from "../server";
import {
  serializeEntry,
  serializePlanVersion,
  serializeSlot,
  toolJson,
} from "../serializers";
import { runTool } from "../tool-runner";

/**
 * Reading a planned week.
 *
 * The version parameter exists because a plan is a stack of immutable versions,
 * not a mutable document. An agent that wants to know what the user actually
 * intends reads `active`; one that wants to rebase after a conflict reads a
 * specific number.
 */

/**
 * `year` and `week` are optional together or not at all.
 *
 * They used to be independently optional, so `{ week: 40 }` was accepted and
 * silently answered about the current week: an agent asking about week 40 got
 * week 37's meals with `"week": 37` in the reply, which it has no reason to
 * re-read. The refinement is why this schema is parsed in the handler as well as
 * spread into `inputSchema`: the SDK rebuilds its own object from the shape it
 * is handed, which drops any object-level check.
 */
const getWeekParamsSchema = z
  .object({
    year: z
      .number()
      .int()
      .min(1970)
      .max(9999)
      .optional()
      .describe(
        "Année de numérotation ISO. À donner avec `week`. Omettez les deux pour la semaine en cours.",
      ),
    week: z
      .number()
      .int()
      .min(1)
      .max(53)
      .optional()
      .describe(
        "Numéro de semaine ISO. À donner avec `year`. Omettez les deux pour la semaine en cours.",
      ),
    version: z
      .union([
        z.literal("active"),
        z.literal("pending"),
        z.number().int().min(1),
      ])
      .default("active")
      .describe(
        "`active` pour le plan qui fait foi, `pending` pour une proposition " +
          "en attente de validation, ou un numéro de version précis.",
      ),
  })
  .superRefine((value, ctx) => {
    if ((value.year === undefined) === (value.week === undefined)) return;
    ctx.addIssue({
      code: "custom",
      path: [value.year === undefined ? "year" : "week"],
      message: `Donnez \`year\` et \`week\` ensemble, ou aucun des deux pour la semaine en cours. Un numéro de semaine sans année est ambigu au passage d'une année à l'autre, et la semaine en cours est ${formatIsoWeek(currentIsoWeek())}.`,
    });
  });

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
      inputSchema: getWeekParamsSchema.shape,
    },
    async (args) =>
      runTool(
        caller,
        {
          name: "get_week",
          direction: "read",
          requiredScopes: ["plan:read"],
          payloadSummary: {
            year: args.year,
            week: args.week,
            version: args.version,
          },
        },
        async (ctx) => {
          const { year, week, version } = getWeekParamsSchema.parse(args);
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
                : (versions.find((row) => row.versionNumber === version) ??
                  null);

          // A version that was asked for by name and does not exist is a
          // NOT_FOUND, whichever name was used. `pending` used to be the
          // exception: with no pending version it answered `version: null,
          // entries: []`, which is byte for byte what an unplanned week returns,
          // so an agent could not tell "your proposal is gone" from "nobody has
          // planned this week" and would happily propose over the top of an
          // active plan.
          if (version !== "active" && chosen === null) {
            throw new DomainError(
              "NOT_FOUND",
              version === "pending"
                ? `Aucune proposition n'est en attente pour ${formatIsoWeek(target)}. Versions existantes : ${describeVersions(versions)}. Lisez \`active\` pour le plan qui fait foi.`
                : `La version ${version} n'existe pas pour ${formatIsoWeek(target)}. Versions disponibles : ${describeVersions(versions)}.`,
              {
                requested: version,
                available: versions.map((row) => row.versionNumber),
                states: versions.map((row) => ({
                  number: row.versionNumber,
                  state: row.state,
                })),
              },
            );
          }

          const entries =
            chosen === null
              ? []
              : chosen.id === view.activeVersion?.id
                ? view.entries
                : await getVersionEntries(ctx, chosen.id);

          return toolJson({
            year: target.year,
            week: target.week,
            version: chosen === null ? null : serializePlanVersion(chosen),
            // The token an agent hands back to a write call so a concurrent
            // edit cannot be silently overwritten.
            expected_base_version: view.activeVersion?.versionNumber ?? null,
            slots: view.slots.map(serializeSlot),
            entries: entries.map(serializeEntry),
            // Entries whose slot is no longer planned. Kept, never dropped.
            orphaned_entries: view.orphanedEntries.map(serializeEntry),
            versions: versions.map((row) => ({
              number: row.versionNumber,
              state: row.state,
              created_by: row.createdBy,
            })),
          });
        },
      ),
  );
}

function describeVersions(
  versions: readonly { versionNumber: number; state: string }[],
): string {
  return (
    versions.map((row) => `${row.versionNumber} (${row.state})`).join(", ") ||
    "aucune"
  );
}
