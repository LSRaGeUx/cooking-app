import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { pantryItemInputSchema } from "@/domain/schemas";
import {
  addPantryItems,
  listPantry,
  removePantryItem,
  restorePantryItem,
} from "@/services/pantry-service";
import { pantryItemParamsSchema, toPantryItemInput } from "../schemas";
import type { McpCallerContext } from "../server";
import { serializePantryItem, toolJson } from "../serializers";
import { runTool } from "../tool-runner";

/**
 * The pantry over MCP.
 *
 * `add_pantry_items` is the one write an agent will reach for mid-conversation,
 * because "I've got half a cabbage left" arrives in chat, not in a form. The
 * description says so, and says what the lists are not: no quantities, no stock
 * accounting, nothing to reconcile.
 *
 * Removal is a soft delete and has a counterpart, `restore_pantry_item`. Rule 6
 * says nothing an agent does is irreversible, and the pantry is where it matters
 * most in practice: a use-soon item can be the thing an allergen note or a
 * whole week's plan was built around, and an agent that misheard "the cabbage is
 * gone" must be able to put it back rather than ask the user to retype it.
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
        "n'a été saisi. Les produits retirés n'apparaissent pas ici.",
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
          return toolJson({
            staples: items
              .filter((item) => item.kind === "staple")
              .map(serializePantryItem),
            use_soon: items
              .filter((item) => item.kind === "use_soon")
              .map(serializePantryItem),
            note: "Une liste vide signifie « rien de saisi », pas « placard vide ».",
          });
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
        items: z
          .array(pantryItemParamsSchema)
          .min(1)
          .max(20)
          .describe("Un ou plusieurs produits, ajoutés en une fois."),
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
          const inputs = args.items.map((item) =>
            pantryItemInputSchema.parse(toPantryItemInput(item)),
          );
          const created = await addPantryItems(ctx, inputs);
          return toolJson({ added: created.map(serializePantryItem) });
        },
      ),
  );

  server.registerTool(
    "remove_pantry_item",
    {
      title: "Retirer des placards",
      description:
        "Retire un produit des placards, par exemple parce qu'il a été " +
        "consommé ou jeté.\n\n" +
        "Le produit n'est pas supprimé, seulement retiré : il disparaît de " +
        "`get_pantry` et de la liste de courses, et `restore_pantry_item` le " +
        "remet en place à l'identique. Retirez donc sans hésiter ce que la " +
        "personne vous dit avoir fini, l'erreur se corrige.",
      inputSchema: {
        item_id: z
          .uuid()
          .describe(
            "Identifiant du produit, tel que renvoyé par `get_pantry`.",
          ),
      },
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
          return toolJson({
            removed: args.item_id,
            note: "Retiré, pas supprimé. `restore_pantry_item` le remet en place.",
          });
        },
      ),
  );

  server.registerTool(
    "restore_pantry_item",
    {
      title: "Remettre un produit dans les placards",
      description:
        "Annule un retrait : le produit revient dans les placards avec son " +
        "nom, sa quantité et sa date limite d'origine.\n\n" +
        "À utiliser dès que la personne vous corrige, plutôt que de rajouter le " +
        "produit avec `add_pantry_items`, ce qui en créerait un second et " +
        "perdrait sa date limite.",
      inputSchema: {
        item_id: z.uuid().describe("Identifiant du produit retiré à remettre."),
      },
    },
    async (args) =>
      runTool(
        caller,
        {
          name: "restore_pantry_item",
          direction: "write",
          requiredScopes: ["pantry:write"],
          payloadSummary: { itemId: args.item_id },
        },
        async (ctx) => {
          const restored = await restorePantryItem(ctx, args.item_id);
          return toolJson({ restored: serializePantryItem(restored) });
        },
      ),
  );
}
