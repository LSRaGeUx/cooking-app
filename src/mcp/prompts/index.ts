import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { McpCallerContext } from "../server";

/**
 * Server-provided prompts.
 *
 * Since there is no server-side model, this is where the steering lives that a
 * prompt would normally carry. Exposing them over MCP means a client can offer
 * them natively, so the user does not have to paste anything: the difference
 * between a product that works and a product with a documentation page.
 *
 * The same text ships as files under `public/agent-pack/` for clients that
 * cannot read MCP prompts.
 */

const HOUSE_RULES = `Règles de la maison, valables pour tout ce que vous faites ici :

1. La section 1 du profil est absolue. Un allergène strict ne se contourne jamais, quelle que soit la demande.
2. Un créneau « sauté » ne se remplit pas. L'utilisateur a décidé de ne pas cuisiner ce soir-là.
3. Le budget de temps d'un créneau porte sur le temps de cuisine active, pas sur le temps total.
4. Chaque repas que vous proposez doit citer ce qui l'a motivé. Un fait, une contrainte, un reste à finir. Sans cela l'utilisateur ne peut corriger que le plat.
5. Vérifiez avant d'écrire. \`check_feasibility\` renvoie tous les problèmes d'un coup ; une proposition refusée coûte un aller-retour de plus.
6. Terminez toujours par le lien \`review_url\`. C'est par là que l'utilisateur voit ce que vous avez fait.`;

export function registerPrompts(
  server: McpServer,
  _caller: McpCallerContext,
): void {
  server.registerPrompt(
    "plan_my_week",
    {
      title: "Planifier ma semaine",
      description:
        "La séquence recommandée pour proposer une semaine complète : lire le " +
        "profil, survoler la bibliothèque, vérifier, proposer, rendre le lien.",
      argsSchema: {
        week: z
          .string()
          .optional()
          .describe("Semaine ISO visée, par exemple 2026-W36. Par défaut la semaine en cours."),
        notes: z
          .string()
          .optional()
          .describe("Contraintes particulières pour cette semaine : invités, absence, envie."),
      },
    },
    ({ week, notes }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Planifie ma semaine${week ? ` ${week}` : ""} de cuisine.

${notes ? `Contraintes pour cette semaine : ${notes}\n\n` : ""}Suis cette séquence :

1. Appelle \`get_profile_snapshot\`. Lis-le en entier avant de proposer quoi que ce soit.
2. Lis la ressource \`cooking://recipes/index\` pour voir toute la bibliothèque d'un coup, avec depuis combien de semaines chaque plat n'a pas été planifié.
3. Appelle \`get_week\` sur la semaine visée pour connaître les créneaux réellement planifiables et récupérer \`expected_base_version\`.
4. Compose la semaine. Privilégie ce qui n'a pas été mangé depuis longtemps, respecte les budgets de temps créneau par créneau, et n'invente une recette que si la bibliothèque ne répond pas.
5. Appelle \`check_feasibility\` avec la semaine complète. Corrige tout ce qu'elle renvoie.
6. Appelle \`propose_week\` avec le même contenu et \`expected_base_version\`.
7. Termine ta réponse par le lien \`review_url\`.

${HOUSE_RULES}`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "weekly_review",
    {
      title: "Faire le point sur la semaine",
      description:
        "Relire ce qui s'est passé, en tirer des faits, et proposer des " +
        "corrections de budget de temps.",
      argsSchema: {
        week: z
          .string()
          .optional()
          .describe("Semaine ISO à relire. Par défaut la semaine écoulée."),
      },
    },
    ({ week }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: `Fais le point sur ma semaine${week ? ` ${week}` : " écoulée"}.

1. Appelle \`get_week\` sur la semaine concernée et \`get_profile_snapshot\` pour le contexte.
2. Demande-moi ce qui a réellement été cuisiné, ce qui a été sauté, et ce qui a pris plus de temps que prévu. Ne le devine pas.
3. Transforme ce que j'ai dit en faits avec \`record_facts\`. Un fait par idée, court, avec la preuve dans \`evidence\`. Mets \`confidence\` à \`low\` pour ce qui repose sur un seul repas.
4. Si un fait existant est contredit par ce que je viens de dire, retire-le avec \`retire_fact\` en expliquant pourquoi, puis écris le nouveau.
5. Si un créneau déborde régulièrement, dis-le-moi et propose un budget plus réaliste. Ne le change pas toi-même : c'est un réglage qui m'appartient.

${HOUSE_RULES}`,
          },
        },
      ],
    }),
  );
}
