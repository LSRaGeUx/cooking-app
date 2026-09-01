import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { pantryItemInputSchema } from "@/domain/schemas";
import {
  addPantryItems,
  listPantry,
  removePantryItem,
} from "@/services/pantry-service";
import type { McpCallerContext } from "../server";
import { runTool } from "../tool-runner";

/**
 * The pantry over MCP.
 *
 * `add_pantry_items` is the one write an agent will reach for mid-conversation,
 * because "I've got half a cabbage left" arrives in chat, not in a form. The
 * description says so, and says what the lists are not: no quantities, no stock
 * accounting, nothing to reconcile.
 */
export function registerPantryTools(
  server: McpServer,
  caller: McpCallerContext,
): void {
  server.registerTool(
    "get_pantry",
    {
      title: "Lire les placards",
      description:
        "Renvoie deux listes : les produits toujours en stock, et ceux à " +
        "consommer bientôt.\n\n" +
        "Les produits à consommer bientôt sont une priorité de planification : " +
        "proposez de préférence des plats qui les utilisent, et dites-le dans " +
        "la justification. Les produits toujours en stock n'ont pas besoin " +
        "d'être achetés, ils sont retirés de la liste de courses.\n\n" +
        "Une liste vide ne veut pas dire des placards vides, seulement que rien " +
        "n'a été saisi.",
      inputSchema: {},
    },
    async () =>
      runTool(
        caller,
        {
          name: "get_pantry",
          direction: "read",
          requiredScopes: ["pantry:read"],
        },
        async (ctx) => {
          const items = await listPantry(ctx);
          return JSON.stringify(
            {
              staples: items
                .filter((item) => item.kind === "staple")
                .map(serialize),
              use_soon: items
                .filter((item) => item.kind === "use_soon")
                .map(serialize),
              note: "Une liste vide signifie « rien de saisi », pas « placard vide ».",
            },
            null,
            2,
          );
        },
      ),
  );

  server.registerTool(
    "add_pantry_items",
    {
      title: "Ajouter aux placards",
      description:
        "Ajoute des produits aux placards. À utiliser quand la personne " +
        "mentionne en passant ce qu'il lui reste : « il me reste la moitié d'un " +
        "chou » se note en `use_soon`, « j'ai toujours des pâtes » en `staple`.\n\n" +
        "Les quantités sont du texte libre et il n'y a aucune comptabilité de " +
        "stock : rien n'est décrémenté quand un plat est cuisiné. C'est " +
        "volontaire, la tenue de stock est ce qui fait abandonner ce genre de " +
        "fonctionnalité.",
      inputSchema: {
        items: z.array(pantryItemInputSchema).min(1).max(20),
      },
    },
    async (args) =>
      runTool(
        caller,
        {
          name: "add_pantry_items",
          direction: "write",
          requiredScopes: ["pantry:write"],
          payloadSummary: { count: args.items.length },
        },
        async (ctx) => {
          const created = await addPantryItems(ctx, args.items);
          return JSON.stringify({ added: created.map(serialize) }, null, 2);
        },
      ),
  );

  server.registerTool(
    "remove_pantry_item",
    {
      title: "Retirer des placards",
      description:
        "Retire un produit des placards, par exemple parce qu'il a été " +
        "consommé ou jeté.",
      inputSchema: { item_id: z.uuid() },
    },
    async (args) =>
      runTool(
        caller,
        {
          name: "remove_pantry_item",
          direction: "write",
          requiredScopes: ["pantry:write"],
          payloadSummary: { itemId: args.item_id },
        },
        async (ctx) => {
          await removePantryItem(ctx, args.item_id);
          return JSON.stringify({ removed: args.item_id }, null, 2);
        },
      ),
  );
}

function serialize(item: {
  id: string;
  name: string;
  quantityNote: string | null;
  expiresOn: string | null;
  source: string;
}) {
  return {
    id: item.id,
    name: item.name,
    quantity_note: item.quantityNote,
    expires_on: item.expiresOn,
    source: item.source,
  };
}
