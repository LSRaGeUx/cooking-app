import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadHistory, loadSignals } from "@/services/history-service";
import type { McpCallerContext } from "../server";
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

          return JSON.stringify(
            {
              weeks: history.map((week) => ({
                year: week.year,
                week: week.week,
                meals: week.entries.map((entry) => ({
                  day_of_week: entry.dayOfWeek,
                  recipe_title: entry.recipeTitle,
                  servings: entry.servings,
                  outcome: entry.outcome,
                  rating: entry.rating,
                  swapped_for: entry.swappedFor,
                  took_longer: entry.tookLonger,
                  note: entry.note,
                })),
              })),
              unresolved_signals: signals.map((signal) => ({
                code: signal.code,
                message: signal.message,
                details: signal.details,
              })),
              // Surfaced so an agent can raise it in conversation. It must not
              // change the setting itself: a time budget belongs to the person
              // whose evenings it describes.
              budget_suggestions: budgetSuggestions.map((suggestion) => ({
                day_of_week: suggestion.dayOfWeek,
                meal_type_label: suggestion.mealTypeLabel,
                current_budget_min: suggestion.currentBudgetMin,
                suggested_budget_min: suggestion.suggestedBudgetMin,
                overruns: `${suggestion.overrunCount}/${suggestion.observedCount}`,
              })),
              note: "Un repas sans `outcome` n'a pas été jugé. Ce n'est pas un échec.",
            },
            null,
            2,
          );
        },
      ),
  );
}
