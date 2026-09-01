import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { factInputSchema } from "@/domain/schemas";
import { createFact, retireFact } from "@/services/fact-service";
import type { McpCallerContext } from "../server";
import { runTool } from "../tool-runner";

/**
 * Writing to the fact store, which is the part of this product that compounds.
 *
 * Both descriptions say plainly that an agent's fact is unconfirmed and that
 * nothing here deletes. Stating the guarantee is not just honesty: an agent
 * that knows a claim is reviewable, and that retiring is reversible, writes more
 * useful facts than one hedging against doing damage.
 */
export function registerFactWrites(
  server: McpServer,
  caller: McpCallerContext,
): void {
  server.registerTool(
    "record_facts",
    {
      title: "Enregistrer des faits",
      description:
        "Ajoute ce que vous avez appris sur cette personne : un goût, une " +
        "habitude, une contrainte. Un fait par idée.\n\n" +
        "Vos faits entrent toujours en « non confirmé », quoi que vous " +
        "demandiez, et l'utilisateur les valide ou les retire d'un clic. Ils " +
        "sont visibles et influencent la planification en attendant, donc " +
        "écrivez-les dès que vous apprenez quelque chose plutôt que d'attendre " +
        "d'en être certain : ajustez plutôt `confidence`.\n\n" +
        "Un bon fait est court, atomique et vérifiable. « N'aime pas la " +
        "coriandre » vaut mieux que « semble préférer une cuisine plutôt douce, " +
        "sans trop d'herbes fraîches ». Citez vos preuves dans `evidence`.\n\n" +
        "Avant d'écrire, relisez le profil : contredire un fait existant se fait " +
        "avec `retire_fact` puis un nouveau fait, pas en empilant les deux.",
      inputSchema: {
        facts: z
          .array(factInputSchema)
          .min(1)
          .max(20)
          .describe("Un ou plusieurs faits, écrits en une fois."),
      },
    },
    async (args) =>
      runTool(
        caller,
        {
          name: "record_facts",
          direction: "write",
          requiredScopes: ["profile:write"],
          payloadSummary: { count: args.facts.length },
        },
        async (ctx) => {
          const created = [];
          for (const input of args.facts) {
            created.push(await createFact(ctx, input));
          }
          return JSON.stringify(
            {
              created: created.map((row) => ({
                id: row.id,
                statement: row.statement,
                status: row.status,
              })),
              note: "Ces faits attendent la confirmation de l'utilisateur. Ils sont déjà lisibles et comptent dans la planification.",
            },
            null,
            2,
          );
        },
      ),
  );

  server.registerTool(
    "retire_fact",
    {
      title: "Retirer un fait",
      description:
        "Marque un fait comme n'étant plus vrai. Rien n'est supprimé : le fait " +
        "reste dans l'historique avec sa raison de retrait, parce que « elle " +
        "détestait les champignons, elle en mange maintenant » est une " +
        "information, pas du bruit.\n\n" +
        "Pour remplacer un fait par une version corrigée, retirez l'ancien puis " +
        "écrivez le nouveau avec `record_facts`.",
      inputSchema: {
        fact_id: z.uuid(),
        reason: z
          .string()
          .min(1)
          .max(500)
          .describe(
            "Pourquoi ce fait n'est plus vrai. Conservé et affiché à l'utilisateur.",
          ),
      },
    },
    async (args) =>
      runTool(
        caller,
        {
          name: "retire_fact",
          direction: "write",
          requiredScopes: ["profile:write"],
          payloadSummary: { factId: args.fact_id },
        },
        async (ctx) => {
          const retired = await retireFact(ctx, args.fact_id, args.reason);
          return JSON.stringify(
            {
              id: retired.id,
              statement: retired.statement,
              status: retired.status,
              retirement_reason: retired.retirementReason,
            },
            null,
            2,
          );
        },
      ),
  );
}
