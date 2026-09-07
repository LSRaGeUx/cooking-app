import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadHistory, loadSignals } from "@/services/history-service";
import type { McpCallerContext } from "../server";
import {
  serializeBudgetSuggestion,
  serializeHistoryWeek,
  serializeSignal,
  toolJson,
} from "../serializers";
import { runTool } from "../tool-runner";

/**
 * What was planned, what actually happened, and what the data is saying that
 * nobody has acted on.
 *
 * The description leans hard on one distinction, because getting it wrong makes
 * an agent draw confident conclusions from nothing: a meal with no feedback is
 * unjudged, not failed.
 */
export function registerGetHistory(
  server: McpServer,
  caller: McpCallerContext,
): void {
  server.registerTool(
    "get_history",
    {
      title: "Lire l'historique",
      description:
        "Renvoie ce qui a été planifié les dernières semaines, ce qui en a été " +
        "fait, et les signaux dérivés que personne n'a encore traités.\n\n" +
        "Lisez `outcome` avec précaution. `null` veut dire que la personne n'a " +
        "rien saisi, pas que le repas a raté : la saisie est volontairement " +
        "facultative. Ne comptez comme sauté que ce qui est explicitement " +
        "`skipped`.\n\n" +
        "Les signaux sont des observations, pas des conclusions. « Planifié " +
        "trois fois, jamais cuisiné » est un fait sur les données ; « elle " +
        "n'aime pas ce plat » est une hypothèse que vous pouvez enregistrer " +
        "avec `record_facts`, en confiance basse et en citant la preuve.",
      inputSchema: {
        weeks_back: z
          .number()
          .int()
          .min(1)
          .max(52)
          .default(8)
          .describe("Nombre de semaines à remonter. 8 par défaut."),
      },
    },
    async ({ weeks_back }) =>
      runTool(
        caller,
        {
          name: "get_history",
          direction: "read",
          requiredScopes: ["feedback:read"],
          payloadSummary: { weeksBack: weeks_back },
        },
        async (ctx) => {
          const history = await loadHistory(ctx, weeks_back);
          const { signals, budgetSuggestions } = await loadSignals(ctx);

          return toolJson({
            weeks: history.map(serializeHistoryWeek),
            unresolved_signals: signals.map(serializeSignal),
            // Surfaced so an agent can raise it in conversation. It must not
            // change the setting itself: a time budget belongs to the person
            // whose evenings it describes.
            budget_suggestions: budgetSuggestions.map(
              serializeBudgetSuggestion,
            ),
            note: "Un repas sans `outcome` n'a pas été jugé. Ce n'est pas un échec.",
          });
        },
      ),
  );
}
