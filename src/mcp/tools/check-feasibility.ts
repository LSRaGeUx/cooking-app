import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { proposeWeekSchema } from "@/domain/schemas";
import { formatIsoWeek } from "@/domain/week";
import { checkFeasibility } from "@/services/plan-service";
import { proposeWeekParamsSchema, toProposeWeekInput } from "../schemas";
import type { McpCallerContext } from "../server";
import { serializeWarning, toolJson } from "../serializers";
import { runTool } from "../tool-runner";

/**
 * The dry run, and the reason the rules are usable rather than merely enforced.
 *
 * It exists so an agent can iterate before committing: same validation as
 * `propose_week`, no side effect, and every problem returned at once instead of
 * the first one. Built before the write tool on purpose, so the validation path
 * was exercised by something read-only first.
 *
 * It takes the same parameters as `propose_week`, spelled the same way, which is
 * the whole point of a dry run: an agent that has to rewrite its payload between
 * the check and the write is checking something else.
 */
export function registerCheckFeasibility(
  server: McpServer,
  caller: McpCallerContext,
): void {
  server.registerTool(
    "check_feasibility",
    {
      title: "Vérifier une semaine sans l'écrire",
      description:
        "Passe une semaine proposée dans exactement les mêmes règles que " +
        "`propose_week`, sans rien écrire. Renvoie tous les problèmes d'un " +
        "coup, pas seulement le premier.\n\n" +
        "Utilisez-le avant chaque proposition. Il coûte un appel et vous évite " +
        "une série de refus : allergènes stricts, créneaux sautés, budgets de " +
        "temps dépassés, justifications manquantes, recettes introuvables. Les " +
        "recettes que vous décrivez dans `new_recipes` sont vérifiées elles " +
        "aussi, avant d'exister.\n\n" +
        "`errors` bloque, `warnings` passe mais sera signalé à l'utilisateur.",
      inputSchema: proposeWeekParamsSchema.shape,
    },
    async (args) =>
      runTool(
        caller,
        {
          name: "check_feasibility",
          direction: "read",
          // A dry run of a write still only reads, so it asks for the read
          // scope. An agent allowed to look should be allowed to check.
          requiredScopes: ["plan:read"],
          payloadSummary: {
            week: formatIsoWeek({ year: args.year, week: args.week }),
            entries: args.entries,
          },
        },
        async (ctx) => {
          // Through the domain schema, so the week-53 refinement the SDK drops
          // when it rebuilds an object from `.shape` runs here. A dry run that
          // accepts what the write refuses is worse than no dry run.
          const input = proposeWeekSchema.parse(
            toProposeWeekInput(proposeWeekParamsSchema.parse(args)),
          );
          const report = await checkFeasibility(ctx, input);
          return toolJson({
            feasible: report.errors.length === 0,
            errors: report.errors.map((error) => ({
              code: error.code,
              message: error.message,
              details: error.details,
            })),
            warnings: report.warnings.map(serializeWarning),
          });
        },
      ),
  );
}
