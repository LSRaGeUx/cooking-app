import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { linkPrep } from "@/services/prep-service";
import type { McpCallerContext } from "../server";
import { runTool } from "../tool-runner";

/**
 * Declaring that one cooking session feeds another meal.
 *
 * The description spells out what the link is for, because an agent that does
 * not reach for it will keep proposing thirty-minute dishes on a fifteen-minute
 * Tuesday and getting refused.
 */
export function registerLinkPrep(
  server: McpServer,
  caller: McpCallerContext,
): void {
  server.registerTool(
    "link_prep",
    {
      title: "Relier un repas à une session de cuisine",
      description:
        "Déclare qu'un repas est servi par la cuisine d'un autre repas de la " +
        "même semaine : « on double dimanche, on remange mardi ».\n\n" +
        "C'est l'outil qui rend un créneau très contraint utilisable. Un mardi " +
        "à 15 minutes de budget refusera presque tous les plats ; relié à la " +
        "session du dimanche, il n'a plus qu'un réchauffage à faire.\n\n" +
        "La session de cuisine doit être le même jour ou avant. Les portions " +
        "de la source sont augmentées de ce qui est tiré, et la liste de " +
        "courses ne compte ses ingrédients qu'une fois.",
      inputSchema: {
        year: z.number().int().min(1970).max(9999),
        week: z.number().int().min(1).max(53),
        source_entry_id: z
          .uuid()
          .describe("Le repas qui est réellement cuisiné, tel que renvoyé par `get_week`."),
        dependent_entry_id: z
          .uuid()
          .describe("Le repas qui n'est qu'un réchauffage ou un assemblage."),
        servings_drawn: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe(
            "Portions prélevées sur la session. Par défaut, les portions du repas dépendant.",
          ),
        note: z
          .string()
          .max(500)
          .nullable()
          .default(null)
          .describe("Par exemple « réchauffer 10 min au four »."),
      },
    },
    async (args) =>
      runTool(
        caller,
        {
          name: "link_prep",
          direction: "write",
          requiredScopes: ["plan:write"],
          payloadSummary: {
            week: `${args.year}-W${args.week}`,
            source: args.source_entry_id,
          },
        },
        async (ctx) => {
          const result = await linkPrep(
            ctx,
            { year: args.year, week: args.week },
            {
              sourceEntryId: args.source_entry_id,
              dependentEntryId: args.dependent_entry_id,
              ...(args.servings_drawn === undefined
                ? {}
                : { servingsDrawn: args.servings_drawn }),
              note: args.note,
            },
          );

          return JSON.stringify(
            {
              link_id: result.link.id,
              servings_drawn: result.link.servingsDrawn,
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
