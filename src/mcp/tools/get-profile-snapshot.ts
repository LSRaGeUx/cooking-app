import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { composeProfileSnapshot } from "@/services/snapshot-service";
import type { McpCallerContext } from "../server";
import { toolJson } from "../serializers";
import { runTool } from "../tool-runner";

/**
 * The one call an agent should make before anything else.
 *
 * Tool and parameter descriptions are product copy: they are the only steering
 * available for a model we do not run, so they say what the document is for and
 * how to treat it, not merely what it contains.
 */
export function registerGetProfileSnapshot(
  server: McpServer,
  caller: McpCallerContext,
): void {
  server.registerTool(
    "get_profile_snapshot",
    {
      title: "Profil de cuisine",
      description:
        "Renvoie le document de contexte complet sur cette personne : allergènes " +
        "stricts, régime, forme de la semaine avec les budgets de temps, " +
        "équipement, et les faits connus sur ses goûts et son organisation. " +
        "Appelez-le en premier, une fois par session : il est conçu pour suffire " +
        "à planifier une semaine sans autre lecture. La section 1 contient des " +
        "contraintes absolues qui ne se négocient jamais. Les sections marquées " +
        "comme non disponibles ne veulent pas dire « rien à signaler » mais " +
        "« pas encore mesuré ».",
      inputSchema: {
        format: z
          .enum(["markdown", "json"])
          .default("markdown")
          .describe(
            "`markdown` par défaut : moins de jetons et des contraintes en prose, " +
              "que les modèles suivent plus fidèlement. `json` si vous devez " +
              "traiter les champs par programme.",
          ),
      },
    },
    async ({ format }) =>
      runTool(
        caller,
        {
          name: "get_profile_snapshot",
          direction: "read",
          requiredScopes: ["profile:read"],
          payloadSummary: { format },
        },
        async (ctx) => {
          const { snapshot, markdown } = await composeProfileSnapshot(ctx, {
            // A real agent read, unlike the UI preview, is what the pruning
            // heuristic is meant to measure.
            markReferenced: true,
          });
          return format === "json" ? toolJson(snapshot) : markdown;
        },
      ),
  );
}
