import { z } from "zod";
import {
  AGENT_AUTHORITIES,
  ALLERGEN_SEVERITIES,
  DIETS,
  FACT_CATEGORIES,
  FACT_CONFIDENCES,
  FACT_POLARITIES,
  FACT_STATEMENT_MAX_LENGTH,
  FACT_STATUSES,
  INGREDIENT_CATEGORIES,
  SLOT_STATES,
} from "./vocabulary";
import { CANONICAL_UNITS } from "./ingredient-parser";

/**
 * One set of Zod schemas behind everything: HTTP and server action validation,
 * form types, and the JSON Schema published to agents through MCP. A rule
 * written once cannot drift between the two entry points.
 *
 * The `.describe()` calls are not comments. They become the parameter
 * descriptions an agent reads, which is the only steering available for a model
 * we do not run, so they are reviewed as product copy.
 */

const UNIT_VALUES = Object.values(CANONICAL_UNITS) as [string, ...string[]];

export const isoWeekSchema = z.object({
  year: z
    .number()
    .int()
    .min(1970)
    .max(9999)
    .describe("Année de numérotation ISO, jamais l'année civile supposée."),
  week: z
    .number()
    .int()
    .min(1)
    .max(53)
    .describe("Numéro de semaine ISO, de 1 à 52 ou 53 selon l'année."),
});

export type IsoWeekInput = z.infer<typeof isoWeekSchema>;

export const slotRefSchema = z.object({
  dayOfWeek: z
    .number()
    .int()
    .min(1)
    .max(7)
    .describe("Jour ISO : 1 = lundi, 7 = dimanche."),
  mealTypeId: z
    .uuid()
    .describe("Identifiant du type de repas, tel que renvoyé par la ressource des créneaux."),
});

export type SlotRefInput = z.infer<typeof slotRefSchema>;

export const mealTypeInputSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9_]+$/, "Clé en minuscules, chiffres et tirets bas.")
    .describe("Clé stable du type de repas, par exemple `dinner`."),
  label: z.string().min(1).max(60).describe("Libellé affiché à l'utilisateur."),
  sortOrder: z.number().int().min(0).max(100).default(0),
});

export const slotConfigInputSchema = slotRefSchema.extend({
  state: z
    .enum(SLOT_STATES)
    .describe(
      "`planned` attend une recette, `skipped` est volontairement non planifié et ne doit jamais être rempli, `hidden` n'apparaît pas dans la grille.",
    ),
  timeBudgetMin: z
    .number()
    .int()
    .min(0)
    .max(600)
    .nullable()
    .default(null)
    .describe(
      "Minutes de cuisine active acceptables sur ce créneau. C'est la contrainte d'organisation la plus utile du modèle.",
    ),
  defaultServings: z.number().int().min(1).max(50).nullable().default(null),
});

export type SlotConfigInput = z.infer<typeof slotConfigInputSchema>;

export const profileInputSchema = z.object({
  diet: z.enum(DIETS).default("none"),
  dietNotes: z.string().max(2000).nullable().default(null),
  skillLevel: z.number().int().min(1).max(5).default(3),
  defaultServings: z.number().int().min(1).max(50).default(2),
  defaultTimeBudgetMin: z.number().int().min(0).max(600).nullable().default(null),
  varietyPreference: z
    .number()
    .int()
    .min(1)
    .max(5)
    .default(3)
    .describe("1 = j'aime la répétition, 5 = ne jamais répéter un plat."),
  weeklyBudgetAmount: z.number().min(0).max(100000).nullable().default(null),
  weeklyBudgetCurrency: z.string().length(3).nullable().default(null),
  agentAuthority: z.enum(AGENT_AUTHORITIES).default("proposal"),
  timeBudgetToleranceMin: z.number().int().min(0).max(120).default(10),
});

export type ProfileInput = z.infer<typeof profileInputSchema>;

export const allergenInputSchema = z.object({
  name: z.string().min(1).max(80),
  severity: z
    .enum(ALLERGEN_SEVERITIES)
    .describe(
      "`strict` est un blocage absolu : aucune recette contenant cet allergène ne peut être placée dans un créneau. `avoid` produit un avertissement.",
    ),
  matches: z
    .array(z.string().min(1).max(80))
    .max(100)
    .default([])
    .describe(
      "Noms et synonymes d'ingrédients qui déclenchent l'allergène. La correspondance est explicite : rien n'est déduit au-delà de cette liste.",
    ),
});

export const exclusionInputSchema = z.object({
  name: z.string().min(1).max(80),
  matches: z
    .array(z.string().min(1).max(80))
    .max(100)
    .default([])
    .describe(
      "Noms et synonymes qui déclenchent l'exclusion. Une exclusion produit un avertissement, jamais un blocage.",
    ),
});

export const equipmentInputSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9_]+$/, "Clé en minuscules, chiffres et tirets bas."),
  label: z.string().min(1).max(60).nullable().default(null),
});

export const factInputSchema = z.object({
  category: z
    .enum(FACT_CATEGORIES)
    .describe(
      "Catégorie du fait. `taste` pour les goûts, `organization` pour le rythme et les habitudes de la semaine, `pantry_habit` pour les placards, `social` pour les repas partagés, `health` pour les contraintes de santé non allergiques, `equipment` et `technique` pour la cuisine elle-même.",
    ),
  statement: z
    .string()
    .min(1)
    .max(FACT_STATEMENT_MAX_LENGTH)
    .describe(
      `Une seule assertion, ${FACT_STATEMENT_MAX_LENGTH} caractères maximum. « N'aime pas la coriandre », pas un paragraphe. Un fait qui contient deux idées doit être écrit comme deux faits.`,
    ),
  polarity: z
    .enum(FACT_POLARITIES)
    .default("neutral")
    .describe(
      "`negative` pour un rejet ou une contrainte, `positive` pour une appétence, `neutral` pour une observation.",
    ),
  confidence: z
    .enum(FACT_CONFIDENCES)
    .default("medium")
    .describe(
      "Votre degré de certitude. Un fait déduit d'un seul repas est `low`, une préférence énoncée explicitement est `high`.",
    ),
  evidence: z
    .array(z.string().min(1).max(200))
    .max(20)
    .default([])
    .describe(
      "Références qui appuient le fait : identifiants d'entrées de plan, de retours, ou texte libre. Un fait cité sans preuve reste recevable mais moins convaincant.",
    ),
});

export type FactInput = z.infer<typeof factInputSchema>;

/**
 * What may be changed without superseding: how a fact is filed and how sure we
 * are of it. The statement and the polarity are the fact's meaning, and changing
 * a meaning in place is what the supersede path exists to prevent.
 */
export const factMetadataSchema = z.object({
  category: z.enum(FACT_CATEGORIES).optional(),
  confidence: z.enum(FACT_CONFIDENCES).optional(),
});

export const factFilterSchema = z.object({
  category: z.enum(FACT_CATEGORIES).optional(),
  status: z.enum(FACT_STATUSES).optional(),
  polarity: z.enum(FACT_POLARITIES).optional(),
  includeRetired: z.boolean().default(false),
});

export type FactFilter = z.infer<typeof factFilterSchema>;

export const ingredientInputSchema = z.object({
  canonicalName: z.string().min(1).max(120),
  aliases: z.array(z.string().min(1).max(120)).max(50).default([]),
  category: z.enum(INGREDIENT_CATEGORIES).default("other"),
  aisle: z.string().max(60).nullable().default(null),
  defaultUnit: z.string().max(20).nullable().default(null),
});

export const recipeIngredientInputSchema = z.object({
  quantity: z.number().min(0).max(100000).nullable().default(null),
  unit: z
    .string()
    .max(20)
    .nullable()
    .default(null)
    .describe(
      `Unité métrique. Unités canoniques : ${UNIT_VALUES.join(", ")}. Une unité inconnue est conservée telle quelle mais ne pourra pas être fusionnée dans une liste de courses.`,
    ),
  rawName: z
    .string()
    .min(1)
    .max(200)
    .describe("Nom de l'ingrédient tel qu'il est écrit dans la recette."),
  note: z.string().max(200).nullable().default(null),
  optional: z
    .boolean()
    .default(false)
    .describe("Un ingrédient optionnel est exclu de la liste de courses par défaut."),
  ingredientId: z
    .uuid()
    .nullable()
    .default(null)
    .describe(
      "Lien vers l'ingrédient normalisé. Facultatif : un ingrédient non lié se cuisine très bien, il perd seulement la fusion dans la liste de courses.",
    ),
});

export type RecipeIngredientInput = z.infer<typeof recipeIngredientInputSchema>;

export const recipeStepInputSchema = z.object({
  text: z.string().min(1).max(4000),
  durationMin: z.number().int().min(0).max(1440).nullable().default(null),
  unattended: z
    .boolean()
    .default(false)
    .describe(
      "Une étape non surveillée (four, repos) ne compte pas dans le temps actif, qui est ce que le budget d'un créneau contraint.",
    ),
});

export const recipeInputSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(4000).nullable().default(null),
  servings: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(2)
    .describe("Nombre de portions auquel les quantités correspondent."),
  prepTimeMin: z.number().int().min(0).max(1440).nullable().default(null),
  cookTimeMin: z.number().int().min(0).max(1440).nullable().default(null),
  activeTimeMin: z
    .number()
    .int()
    .min(0)
    .max(1440)
    .nullable()
    .default(null)
    .describe(
      "Minutes de présence réelle en cuisine, distinctes du temps total : une heure de four ne consomme pas la soirée.",
    ),
  batchFriendly: z
    .boolean()
    .default(false)
    .describe("La recette se double et se conserve, donc elle peut servir de session de batch."),
  keepsDays: z.number().int().min(0).max(30).nullable().default(null),
  tags: z.array(z.string().min(1).max(40)).max(30).default([]),
  cuisine: z.string().max(60).nullable().default(null),
  mainProtein: z.string().max(60).nullable().default(null),
  difficulty: z.string().max(40).nullable().default(null),
  equipmentKeys: z.array(z.string().min(1).max(40)).max(20).default([]),
  ingredients: z.array(recipeIngredientInputSchema).max(100).default([]),
  steps: z.array(recipeStepInputSchema).max(100).default([]),
});

export type RecipeInput = z.infer<typeof recipeInputSchema>;

export const recipeSearchSchema = z.object({
  query: z.string().max(200).optional(),
  tags: z.array(z.string().min(1).max(40)).max(10).optional(),
  maxActiveTimeMin: z.number().int().min(0).max(1440).optional(),
  mainProtein: z.string().max(60).optional(),
  batchFriendly: z.boolean().optional(),
  notPlannedInWeeks: z
    .number()
    .int()
    .min(1)
    .max(104)
    .optional()
    .describe(
      "Ne renvoie que les recettes absentes des plans actifs des N dernières semaines. C'est le filtre qui répond à « propose-moi quelque chose que je n'ai pas mangé depuis longtemps ». Il porte sur ce qui a été planifié, pas sur ce qui a été réellement cuisiné : les retours après cuisson n'existent pas encore.",
    ),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
});

export type RecipeSearchInput = z.infer<typeof recipeSearchSchema>;

export const planEntryInputSchema = slotRefSchema.extend({
  recipeId: z.uuid(),
  servings: z.number().int().min(1).max(50).nullable().default(null),
  note: z.string().max(500).nullable().default(null),
  position: z.number().int().min(0).max(10).default(0),
  // Optional here because a person editing their own week owes nobody an
  // explanation. The service requires it of an agent.
  rationale: z.string().max(1000).nullable().default(null),
  rationaleRefs: z.array(z.string().min(1).max(100)).max(20).default([]),
});

export type PlanEntryInput = z.infer<typeof planEntryInputSchema>;

/**
 * One meal an agent proposes. `rationale` is required by the schema rather than
 * by a later check, because an agent that cannot say why a dish is there has
 * not personalized anything, and the user is left with nothing to correct but
 * the dish itself.
 */
export const proposedEntrySchema = z.object({
  dayOfWeek: z
    .number()
    .int()
    .min(1)
    .max(7)
    .describe("Jour ISO : 1 = lundi, 7 = dimanche."),
  mealType: z
    .string()
    .min(1)
    .max(40)
    .describe(
      "Clé du type de repas, par exemple `dinner`. Les clés valides sont dans la ressource `cooking://slots`.",
    ),
  recipeRef: z
    .string()
    .min(1)
    .max(100)
    .describe(
      "Identifiant d'une recette existante, ou `temp_id` d'une recette décrite dans `newRecipes` du même appel.",
    ),
  servings: z.number().int().min(1).max(50).nullable().default(null),
  note: z.string().max(500).nullable().default(null),
  rationale: z
    .string()
    .min(1)
    .max(1000)
    .describe(
      "Pourquoi ce plat, à ce créneau, pour cette personne. Citez ce qui l'a motivé : un fait, un budget de temps, un reste à finir. « Rapide et bon » n'est pas une justification ; « 20 min de temps actif pour le créneau du mardi qui en autorise 25, et elle a noté aimer les plats mijotés » en est une.",
    ),
  rationaleRefs: z
    .array(z.string().min(1).max(100))
    .max(20)
    .default([])
    .describe(
      "Identifiants des faits, retours ou produits de placard cités dans la justification. Ils sont affichés à l'utilisateur comme des liens, ce qui lui permet de corriger la cause plutôt que le plat.",
    ),
});

export type ProposedEntryInput = z.infer<typeof proposedEntrySchema>;

export const newRecipeSchema = recipeInputSchema.extend({
  tempId: z
    .string()
    .min(1)
    .max(100)
    .describe(
      "Identifiant temporaire, utilisé par `recipeRef` dans les entrées du même appel. Il n'est pas conservé.",
    ),
});

export const proposeWeekSchema = z.object({
  year: z.number().int().min(1970).max(9999),
  week: z.number().int().min(1).max(53),
  expectedBaseVersion: z
    .number()
    .int()
    .min(1)
    .nullable()
    .default(null)
    .describe(
      "Numéro de la version active au moment de votre lecture, tel que renvoyé par `get_week`. S'il ne correspond plus, l'écriture est refusée : quelqu'un a modifié la semaine entre-temps et vous devez relire avant de reproposer. `null` pour une semaine encore vierge.",
    ),
  summary: z
    .string()
    .max(2000)
    .nullable()
    .default(null)
    .describe(
      "Un paragraphe expliquant la semaine dans son ensemble : l'équilibre visé, les contraintes prises en compte.",
    ),
  newRecipes: z
    .array(newRecipeSchema)
    .max(20)
    .default([])
    .describe(
      "Recettes à créer dans le même appel. Elles sont créées et assignées en une seule transaction : si une entrée est refusée, aucune recette n'est créée.",
    ),
  entries: z.array(proposedEntrySchema).min(1).max(50),
});

export type ProposeWeekInput = z.infer<typeof proposeWeekSchema>;

/**
 * The grid as it was when a version was created, stored on the version so that
 * changing slot configuration later never rewrites history.
 */
export const slotSnapshotSchema = z.array(
  z.object({
    dayOfWeek: z.number().int().min(1).max(7),
    mealTypeId: z.uuid(),
    mealTypeKey: z.string(),
    mealTypeLabel: z.string(),
    state: z.enum(SLOT_STATES),
    timeBudgetMin: z.number().int().nullable(),
    defaultServings: z.number().int().nullable(),
  }),
);

export type SlotSnapshot = z.infer<typeof slotSnapshotSchema>;
