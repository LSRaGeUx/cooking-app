import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { factInputSchema } from "@/domain/schemas";
import { createFacts, restoreFact, retireFact } from "@/services/fact-service";
import type { McpCallerContext } from "../server";
import { toolJson } from "../serializers";
import { runTool } from "../tool-runner";

/**
 * Writing to the fact store, which is the part of this product that compounds.
 *
 * Every description says plainly that an agent's fact is unconfirmed, that
 * nothing here deletes, and which facts an agent may retire. Stating the
 * guarantee is not just honesty: an agent that knows a claim is reviewable, and
 * that retiring is reversible, writes more useful facts than one hedging against
 * doing damage.
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
        "Le lot est écrit en une seule transaction : si un fait est refusé, par " +
        "exemple parce que le plafond de faits actifs est atteint, aucun des " +
        "autres n'est écrit non plus. Vous pouvez donc renvoyer le lot corrigé " +
        "en entier sans risquer de doublon.\n\n" +
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
          // One call, one transaction. This used to loop over `createFact`, so
          // when fact k tripped FACT_CAP_REACHED the first k-1 were already
          // committed and the tool answered with the error alone: the agent was
          // told nothing was written, could not learn what had been, and
          // resending the corrected batch duplicated everything before the cap.
          // Section 6 of docs/03-agent-interface.md says a blocking error writes
          // nothing, and now it does.
          const created = await createFacts(ctx, args.facts);
          return toolJson({
            created: created.map((row) => ({
              id: row.id,
              statement: row.statement,
              status: row.status,
            })),
            note: "Ces faits attendent la confirmation de l'utilisateur. Ils sont déjà lisibles et comptent dans la planification.",
          });
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
        "information, pas du bruit. `restore_fact` annule ce retrait.\n\n" +
        "**Vous ne pouvez retirer qu'un fait non confirmé.** Un fait que " +
        "l'utilisateur a confirmé lui appartient : s'il vous semble faux, " +
        "dites-le-lui et laissez-le décider, ou écrivez le fait contraire avec " +
        "`record_facts` en citant ce que la personne vient de dire. Une " +
        "tentative sur un fait confirmé est refusée, ce n'est pas une erreur de " +
        "votre part.\n\n" +
        "Pour remplacer un fait par une version corrigée, retirez l'ancien puis " +
        "écrivez le nouveau avec `record_facts`.",
      inputSchema: {
        fact_id: z.uuid().describe("Identifiant du fait à retirer."),
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
          return toolJson({
            id: retired.id,
            statement: retired.statement,
            status: retired.status,
            retirement_reason: retired.retirementReason,
          });
        },
      ),
  );

  server.registerTool(
    "restore_fact",
    {
      title: "Rétablir un fait retiré",
      description:
        "Remet en service un fait que vous avez retiré à tort. Rien n'est " +
        "supprimé ici, jamais, donc un retrait se corrige sans rien réécrire : " +
        "le fait reprend sa place avec son historique et sa raison de retrait " +
        "effacée.\n\n" +
        "C'est l'outil à utiliser quand la personne vous corrige juste après un " +
        "retrait. Réécrire le même fait avec `record_facts` créerait un doublon " +
        "et perdrait sa provenance.",
      inputSchema: {
        fact_id: z.uuid().describe("Identifiant du fait retiré à rétablir."),
      },
    },
    async (args) =>
      runTool(
        caller,
        {
          name: "restore_fact",
          direction: "write",
          requiredScopes: ["profile:write"],
          payloadSummary: { factId: args.fact_id },
        },
        async (ctx) => {
          const restored = await restoreFact(ctx, args.fact_id);
          return toolJson({
            id: restored.id,
            statement: restored.statement,
            status: restored.status,
          });
        },
      ),
  );
}
