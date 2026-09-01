import {
  ResourceTemplate,
  type McpServer,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { DomainError } from "@/domain/errors";
import { currentIsoWeek, formatIsoWeek, parseIsoWeek } from "@/domain/week";
import { getWeekView } from "@/services/plan-service";
import { getRecipe, loadRecipeIndex } from "@/services/recipe-service";
import { loadSlotDefinitions } from "@/services/slot-service";
import { composeProfileSnapshot } from "@/services/snapshot-service";
import type { McpCallerContext } from "../server";
import { runResource } from "../tool-runner";

/**
 * Resources are for context an agent pulls once per session and re-reads
 * rarely. Tools are for questions it asks as it works. The same services back
 * both, so the two can never disagree.
 *
 * `cooking://recipes/index` earns its place by being compact: a 200-recipe
 * library must be surveyable in a few hundred tokens, or the agent spends its
 * context on the catalogue instead of the plan.
 */
export function registerResources(
  server: McpServer,
  caller: McpCallerContext,
): void {
  server.registerResource(
    "profile",
    "cooking://profile",
    {
      title: "Profil de cuisine",
      description:
        "Le document de contexte complet sur cette personne. À lire une fois en " +
        "début de session : il est conçu pour suffire à planifier une semaine.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: await runResource(
            caller,
            {
              name: "resource:profile",
              direction: "read",
              requiredScopes: ["profile:read"],
            },
            async (ctx) => {
              const { markdown } = await composeProfileSnapshot(ctx, {
                markReferenced: true,
              });
              return markdown;
            },
          ),
        },
      ],
    }),
  );

  server.registerResource(
    "slots",
    "cooking://slots",
    {
      title: "Créneaux et budgets de temps",
      description:
        "La grille de la semaine : quels repas sont planifiés, lesquels sont " +
        "sautés et ne doivent jamais être remplis, et combien de minutes de " +
        "cuisine active chacun accepte.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: await runResource(
            caller,
            {
              name: "resource:slots",
              direction: "read",
              requiredScopes: ["profile:read"],
            },
            async (ctx) => {
              const slots = await loadSlotDefinitions(ctx);
              return JSON.stringify(
                slots.map((slot) => ({
                  day_of_week: slot.dayOfWeek,
                  meal_type_id: slot.mealTypeId,
                  meal_type_key: slot.mealTypeKey,
                  meal_type_label: slot.mealTypeLabel,
                  state: slot.state,
                  time_budget_min: slot.timeBudgetMin,
                  default_servings: slot.defaultServings,
                })),
                null,
                2,
              );
            },
          ),
        },
      ],
    }),
  );

  server.registerResource(
    "recipe-index",
    "cooking://recipes/index",
    {
      title: "Index des recettes",
      description:
        "Toute la bibliothèque en version compacte : identifiant, titre, temps " +
        "actif, étiquettes, et depuis combien de semaines chaque recette n'a pas " +
        "été planifiée. Lisez ceci plutôt que d'appeler `search_recipes` en " +
        "boucle, puis `get_recipe` seulement pour ce que vous envisagez.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: await runResource(
            caller,
            {
              name: "resource:recipes/index",
              direction: "read",
              requiredScopes: ["recipes:read"],
            },
            async (ctx) => {
              const index = await loadRecipeIndex(ctx);
              return JSON.stringify(
                {
                  count: index.length,
                  note: "weeks_since_last_planned porte sur ce qui a été planifié, pas sur ce qui a été cuisiné. Les retours après cuisson arrivent en phase 6.",
                  recipes: index.map((row) => ({
                    id: row.id,
                    title: row.title,
                    active_time_min: row.activeTimeMin,
                    servings: row.servings,
                    tags: row.tags,
                    main_protein: row.mainProtein,
                    batch_friendly: row.batchFriendly,
                    times_planned: row.timesPlanned,
                    weeks_since_last_planned: row.weeksSinceLastPlanned,
                  })),
                },
                null,
                2,
              );
            },
          ),
        },
      ],
    }),
  );

  server.registerResource(
    "recipe",
    new ResourceTemplate("cooking://recipes/{id}", { list: undefined }),
    {
      title: "Une recette complète",
      description: "Ingrédients, étapes et temps d'une recette précise.",
      mimeType: "application/json",
    },
    async (uri, variables) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: await runResource(
            caller,
            {
              name: "resource:recipes/{id}",
              direction: "read",
              requiredScopes: ["recipes:read"],
            },
            async (ctx) => {
              const id = String(variables.id);
              const detail = await getRecipe(ctx, id);
              return JSON.stringify(detail, null, 2);
            },
          ),
        },
      ],
    }),
  );

  server.registerResource(
    "plan-current",
    "cooking://plan/current",
    {
      title: "Semaine en cours",
      description: "La version active du plan de la semaine ISO en cours.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: await runResource(
            caller,
            {
              name: "resource:plan/current",
              direction: "read",
              requiredScopes: ["plan:read"],
            },
            async (ctx) => renderWeek(await getWeekView(ctx, currentIsoWeek())),
          ),
        },
      ],
    }),
  );

  server.registerResource(
    "plan-week",
    new ResourceTemplate("cooking://plan/{week}", { list: undefined }),
    {
      title: "Une semaine précise",
      description:
        "La version active du plan d'une semaine donnée, au format `2026-W36`.",
      mimeType: "application/json",
    },
    async (uri, variables) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: await runResource(
            caller,
            {
              name: "resource:plan/{week}",
              direction: "read",
              requiredScopes: ["plan:read"],
            },
            async (ctx) => {
              const raw = String(variables.week);
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
          ),
        },
      ],
    }),
  );

  // The two sections the model defines but this build cannot fill. They are
  // served as explicit placeholders rather than omitted, so an agent that looks
  // for them learns why they are empty instead of concluding there is nothing
  // to know.
  registerPlaceholder(
    server,
    caller,
    "pantry",
    "cooking://pantry",
    "Placards",
    "pantry:read",
    "La gestion des placards arrive en phase 7. Ne supposez pas que les placards sont vides : cette information n'est pas encore collectée.",
  );

  registerPlaceholder(
    server,
    caller,
    "history-recent",
    "cooking://history/recent",
    "Historique récent",
    "feedback:read",
    "Les retours après cuisson arrivent en phase 6. Rien n'est encore connu sur ce qui a été réellement cuisiné, noté, ou sauté. Les plans passés restent lisibles via `get_week`.",
  );
}

function registerPlaceholder(
  server: McpServer,
  caller: McpCallerContext,
  name: string,
  uri: string,
  title: string,
  scope: string,
  reason: string,
): void {
  server.registerResource(
    name,
    uri,
    { title, description: reason, mimeType: "application/json" },
    async (resourceUri) => ({
      contents: [
        {
          uri: resourceUri.href,
          mimeType: "application/json",
          text: await runResource(
            caller,
            {
              name: `resource:${name}`,
              direction: "read",
              requiredScopes: [scope],
            },
            async () =>
              JSON.stringify({ available: false, reason }, null, 2),
          ),
        },
      ],
    }),
  );
}

function renderWeek(view: Awaited<ReturnType<typeof getWeekView>>): string {
  return JSON.stringify(
    {
      year: view.isoWeek.year,
      week: view.isoWeek.week,
      active_version: view.activeVersion?.versionNumber ?? null,
      pending_version: view.pendingVersion?.versionNumber ?? null,
      entries: view.entries.map((entry) => ({
        day_of_week: entry.dayOfWeek,
        meal_type_id: entry.mealTypeId,
        recipe_id: entry.recipeId,
        recipe_title: entry.recipeTitleSnapshot,
        servings: entry.servings,
        note: entry.note,
        rationale: entry.rationale,
      })),
    },
    null,
    2,
  );
}
