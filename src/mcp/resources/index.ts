import {
  ResourceTemplate,
  type McpServer,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Variables } from "@modelcontextprotocol/sdk/shared/uriTemplate.js";
import { z } from "zod";
import { DomainError } from "@/domain/errors";
import { currentIsoWeek, formatIsoWeek, parseIsoWeek } from "@/domain/week";
import { loadHistory, loadSignals } from "@/services/history-service";
import { listPantry } from "@/services/pantry-service";
import { getWeekView } from "@/services/plan-service";
import { getRecipe, loadRecipeIndex } from "@/services/recipe-service";
import { loadSlotDefinitions } from "@/services/slot-service";
import { composeProfileSnapshot } from "@/services/snapshot-service";
import type { ServiceContext } from "@/services/context";
import type { McpCallerContext } from "../server";
import {
  serializeEntry,
  serializeHistoryWeek,
  serializePantryItem,
  serializeRecipe,
  serializeRecipeIndexEntry,
  serializeSignal,
  serializeSlot,
  toolJson,
} from "../serializers";
import { runResource } from "../tool-runner";

/**
 * Resources are for context an agent pulls once per session and re-reads
 * rarely. Tools are for questions it asks as it works. The same services back
 * both, and now the same serializers too, so the two can never disagree about
 * what an entity looks like.
 *
 * `cooking://recipes/index` earns its place by being compact: a 200-recipe
 * library must be surveyable in a few hundred tokens, or the agent spends its
 * context on the catalogue instead of the plan.
 */

interface ResourceDefinition {
  /** The registration name, which is what a client lists. */
  readonly name: string;
  /**
   * The name this read is audited under. Kept distinct from the registration
   * name and kept as it was, because these strings are stored in
   * `agent_activity` and rendered on the activity screen: renaming one rewrites
   * how history reads.
   */
  readonly logName: string;
  readonly uri: string | ResourceTemplate;
  readonly title: string;
  readonly description: string;
  readonly mimeType: "application/json" | "text/markdown";
  readonly scopes: readonly string[];
  readonly load: (ctx: ServiceContext, variables: Variables) => Promise<string>;
}

/**
 * The envelope, once.
 *
 * Eight registrations repeated the same six lines, with the mime type written
 * twice in each: once in the metadata a client reads and again in the content
 * block, so a resource could advertise JSON and return Markdown and nothing
 * would notice. Declaring it once is what makes that impossible.
 */
function defineResource(
  server: McpServer,
  caller: McpCallerContext,
  definition: ResourceDefinition,
): void {
  const metadata = {
    title: definition.title,
    description: definition.description,
    mimeType: definition.mimeType,
  };

  const read = async (uri: URL, variables: Variables) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: definition.mimeType,
        text: await runResource(
          caller,
          {
            name: definition.logName,
            direction: "read" as const,
            requiredScopes: definition.scopes,
          },
          (ctx) => definition.load(ctx, variables),
        ),
      },
    ],
  });

  if (typeof definition.uri === "string") {
    server.registerResource(definition.name, definition.uri, metadata, (uri) =>
      read(uri, {}),
    );
    return;
  }

  server.registerResource(
    definition.name,
    definition.uri,
    metadata,
    (uri, variables) => read(uri, variables),
  );
}

/**
 * A templated segment is caller input like any other, so it is parsed before it
 * reaches a service.
 *
 * `cooking://recipes/{id}` used to hand `String(variables.id)` straight to
 * `getRecipe`, so anything that was not a UUID reached Postgres and came back as
 * a `22P02` invalid-input-syntax error, which surfaced as a generic internal
 * failure. An agent guessing at a URI got no indication that the shape of the
 * segment was the problem. The template can also bind a segment as an array, so
 * that case is named rather than stringified into `"a,b"`.
 */
function templateSegment(variables: Variables, key: string): string {
  const raw = variables[key];
  if (typeof raw === "string") return raw;

  throw new DomainError(
    "VALIDATION",
    `L'adresse de cette ressource doit comporter un seul segment « ${key} ».`,
    { parameter: key, received: raw ?? null },
  );
}

function recipeIdFrom(variables: Variables): string {
  const raw = templateSegment(variables, "id");
  const parsed = z.uuid().safeParse(raw);
  if (parsed.success) return parsed.data;

  throw new DomainError(
    "VALIDATION",
    `« ${raw} » n'est pas un identifiant de recette. Le format attendu est un UUID, tel que renvoyé par « cooking://recipes/index », par \`search_recipes\` ou par \`create_recipe\`.`,
    { parameter: "id", received: raw },
  );
}

export function registerResources(
  server: McpServer,
  caller: McpCallerContext,
): void {
  defineResource(server, caller, {
    name: "profile",
    logName: "resource:profile",
    uri: "cooking://profile",
    title: "Profil de cuisine",
    description:
      "Le document de contexte complet sur cette personne. À lire une fois en " +
      "début de session : il est conçu pour suffire à planifier une semaine.",
    mimeType: "text/markdown",
    scopes: ["profile:read"],
    load: async (ctx) => {
      const { markdown } = await composeProfileSnapshot(ctx, {
        markReferenced: true,
      });
      return markdown;
    },
  });

  defineResource(server, caller, {
    name: "slots",
    logName: "resource:slots",
    uri: "cooking://slots",
    title: "Créneaux et budgets de temps",
    description:
      "La grille de la semaine : quels repas sont planifiés, lesquels sont " +
      "sautés et ne doivent jamais être remplis, et combien de minutes de " +
      "cuisine active chacun accepte.",
    mimeType: "application/json",
    scopes: ["profile:read"],
    load: async (ctx) => {
      const slots = await loadSlotDefinitions(ctx);
      return toolJson(slots.map(serializeSlot));
    },
  });

  defineResource(server, caller, {
    name: "recipe-index",
    logName: "resource:recipes/index",
    uri: "cooking://recipes/index",
    title: "Index des recettes",
    description:
      "Toute la bibliothèque en version compacte : identifiant, titre, temps " +
      "actif, étiquettes, et depuis combien de semaines chaque recette n'a pas " +
      "été planifiée. Lisez ceci plutôt que d'appeler `search_recipes` en " +
      "boucle, puis `get_recipe` seulement pour ce que vous envisagez.",
    mimeType: "application/json",
    scopes: ["recipes:read"],
    load: async (ctx) => {
      const index = await loadRecipeIndex(ctx);
      return toolJson({
        count: index.length,
        note: "weeks_since_last_planned porte sur ce qui a été planifié ; weeks_since_last_cooked sur ce qui a été réellement cuisiné, d'après les retours saisis. Une recette sans retour n'apparaît pas comme cuisinée.",
        recipes: index.map(serializeRecipeIndexEntry),
      });
    },
  });

  defineResource(server, caller, {
    name: "recipe",
    logName: "resource:recipes/{id}",
    uri: new ResourceTemplate("cooking://recipes/{id}", { list: undefined }),
    title: "Une recette complète",
    description:
      "Ingrédients, étapes et temps d'une recette précise. Renvoie exactement " +
      "ce que renvoie `get_recipe`.",
    mimeType: "application/json",
    scopes: ["recipes:read"],
    load: async (ctx, variables) =>
      toolJson(serializeRecipe(await getRecipe(ctx, recipeIdFrom(variables)))),
  });

  defineResource(server, caller, {
    name: "plan-current",
    logName: "resource:plan/current",
    uri: "cooking://plan/current",
    title: "Semaine en cours",
    description: "La version active du plan de la semaine ISO en cours.",
    mimeType: "application/json",
    scopes: ["plan:read"],
    load: async (ctx) => renderWeek(await getWeekView(ctx, currentIsoWeek())),
  });

  defineResource(server, caller, {
    name: "plan-week",
    logName: "resource:plan/{week}",
    uri: new ResourceTemplate("cooking://plan/{week}", { list: undefined }),
    title: "Une semaine précise",
    description:
      "La version active du plan d'une semaine donnée, au format `2026-W36`.",
    mimeType: "application/json",
    scopes: ["plan:read"],
    load: async (ctx, variables) => {
      const raw = templateSegment(variables, "week");
      const parsed = parseIsoWeek(raw);
      if (!parsed) {
        throw new DomainError(
          "VALIDATION",
          `« ${raw} » n'est pas une semaine ISO valide. Le format attendu est ${formatIsoWeek(currentIsoWeek())}, avec l'année, parce qu'un numéro de semaine seul est ambigu.`,
          { received: raw },
        );
      }
      return renderWeek(await getWeekView(ctx, parsed));
    },
  });

  defineResource(server, caller, {
    name: "pantry",
    logName: "resource:pantry",
    uri: "cooking://pantry",
    title: "Placards",
    description:
      "Ce qui est toujours en stock, et ce qu'il faut consommer bientôt. Les " +
      "seconds sont une priorité de planification. Une liste vide signifie " +
      "« rien de saisi », pas « placard vide ».",
    mimeType: "application/json",
    scopes: ["pantry:read"],
    load: async (ctx) => {
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
  });

  defineResource(server, caller, {
    name: "history-recent",
    logName: "resource:history/recent",
    uri: "cooking://history/recent",
    title: "Historique récent",
    description:
      "Les huit dernières semaines : ce qui était planifié, ce qui a été " +
      "cuisiné, sauté ou remplacé, et les notes. Un repas sans retour n'a pas " +
      "été jugé, ce qui n'est pas la même chose qu'un repas raté.",
    mimeType: "application/json",
    scopes: ["feedback:read"],
    load: async (ctx) => {
      const history = await loadHistory(ctx, 8);
      const { signals } = await loadSignals(ctx);
      return toolJson({
        weeks: history.map(serializeHistoryWeek),
        unresolved_signals: signals.map(serializeSignal),
        note: "Un repas sans `outcome` n'a pas été jugé, pas raté.",
      });
    },
  });
}

function renderWeek(view: Awaited<ReturnType<typeof getWeekView>>): string {
  return toolJson({
    year: view.isoWeek.year,
    week: view.isoWeek.week,
    active_version: view.activeVersion?.versionNumber ?? null,
    pending_version: view.pendingVersion?.versionNumber ?? null,
    // Through the shared serializer, so an entry read here carries its `id` and
    // can be handed to `link_prep`. This block used to be its own copy of
    // `get_week`'s mapping with the id left out, which made the resource a
    // dead end for the one tool that needs entry ids.
    entries: view.entries.map(serializeEntry),
  });
}
