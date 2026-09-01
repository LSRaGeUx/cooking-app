import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { proposeWeekSchema } from "@/domain/schemas";
import { checkFeasibility } from "@/services/plan-service";
import type { McpCallerContext } from "../server";
import { runTool } from "../tool-runner";

/**
 * The dry run, and the reason the rules are usable rather than merely enforced.
 *
 * It exists so an agent can iterate before committing: same validation as
 * `propose_week`, no side effect, and every problem returned at once instead of
 * the first one. Built before the write tool on purpose, so the validation path
 * was exercised by something read-only first.
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
        "recettes que vous décrivez dans `newRecipes` sont vérifiées elles " +
        "aussi, avant d'exister.\n\n" +
        "`errors` bloque, `warnings` passe mais sera signalé à l'utilisateur.",
      inputSchema: proposeWeekSchema.shape,
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
            week: `${args.year}-W${args.week}`,
            entries: args.entries.length,
          },
        },
        async (ctx) => {
          const report = await checkFeasibility(ctx, args);
          return JSON.stringify(
            {
              feasible: report.errors.length === 0,
              errors: report.errors.map((error) => ({
                code: error.code,
                message: error.message,
                details: error.details,
              })),
              warnings: report.warnings.map((warning) => ({
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
