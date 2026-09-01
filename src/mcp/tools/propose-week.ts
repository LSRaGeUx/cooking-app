import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { proposeWeekSchema } from "@/domain/schemas";
import { proposeWeek } from "@/services/plan-service";
import type { McpCallerContext } from "../server";
import { runTool } from "../tool-runner";

/**
 * The central call, and the one the whole product is for.
 *
 * The description carries three things an agent cannot infer from the schema:
 * that recipes and entries are created in one transaction, that the result may
 * be a proposal rather than a plan depending on a setting it does not control,
 * and that the returned review link is what it should hand back to the user.
 */
export function registerProposeWeek(
  server: McpServer,
  caller: McpCallerContext,
): void {
  server.registerTool(
    "propose_week",
    {
      title: "Proposer une semaine",
      description:
        "Écrit une semaine entière en un seul appel : les recettes que vous " +
        "inventez sont créées et assignées dans la même transaction, donc rien " +
        "n'est écrit si une seule entrée est refusée. Appelez `check_feasibility` " +
        "d'abord pour connaître tous les problèmes d'un coup.\n\n" +
        "Selon le réglage d'autorité de l'utilisateur, le résultat s'applique " +
        "tout de suite ou attend sa validation. Vous ne choisissez pas : la " +
        "réponse vous dit dans quel état la version a été écrite.\n\n" +
        "Terminez toujours votre réponse à l'utilisateur par le lien " +
        "`review_url` renvoyé ici. C'est le passage de la conversation à " +
        "l'application, et sans lui il ne sait pas où aller regarder.\n\n" +
        "Cet appel remplace la semaine entière. Pour changer un seul repas, " +
        "utilisez `update_slot`.",
      inputSchema: proposeWeekSchema.shape,
    },
    async (args) =>
      runTool(
        caller,
        {
          name: "propose_week",
          direction: "write",
          requiredScopes: ["plan:write"],
          payloadSummary: {
            week: `${args.year}-W${args.week}`,
            entries: args.entries.length,
            newRecipes: args.newRecipes.length,
          },
        },
        async (ctx) => {
          const result = await proposeWeek(ctx, args);
          return JSON.stringify(
            {
              version_id: result.version.id,
              version_number: result.version.versionNumber,
              state: result.version.state,
              review_url: result.reviewUrl,
              entries: result.entries.length,
              // Written, but the user will see them flagged. Say so in your
              // reply rather than letting them find out on the screen.
              warnings: result.warnings.map((warning) => ({
                code: warning.code,
                message: warning.message,
              })),
              next_step:
                result.version.state === "pending"
                  ? "La proposition attend la validation de l'utilisateur. Donnez-lui review_url."
                  : "La semaine est active. Donnez review_url à l'utilisateur pour qu'il la voie.",
            },
            null,
            2,
          );
        },
      ),
  );
}
