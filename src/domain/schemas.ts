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
  FEEDBACK_OUTCOMES,
  INGREDIENT_CATEGORIES,
  PANTRY_KINDS,
  PORTION_ISSUES,
  SLOT_STATES,
} from "./vocabulary";
import { CANONICAL_UNITS } from "./ingredient-parser";
import { isValidIsoWeek, isoWeeksInYear } from "./week";

/**
 * One set of Zod schemas behind everything: HTTP and server action validation,
 * form types, and the JSON Schema published to agents through MCP. A rule
 * written once cannot drift between the two entry points.
 *
 * The `.describe()` calls are not comments. They become the parameter
 * descriptions an agent reads, which is the only steering available for a model
 * we do not run, so they are reviewed as product copy.
 */

// A plain array. It was cast to `[string, ...string[]]`, a tuple type that
// exists so a value can be handed to `z.enum`, and the only thing done with it
// here is `.join`, which any array does.
const UNIT_VALUES = Object.values(CANONICAL_UNITS);

/**
 * An ISO week that the year actually has.
 *
 * `week` is bounded at 53 by the field, and most years have 52, so a bare range
 * check accepted 2026-W53 and let a plan row be written for a week that does
 * not exist, through MCP and through the server actions alike. `isValidIsoWeek`
 * knew the answer and was called from nowhere. The refinement names the last
 * valid week of the year the caller asked about, because an agent told
 * "semaine invalide" retries the same number and an agent told the year ends at
 * 52 corrects itself.
 */
export const isoWeekSchema = z
  .object({
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
  })
  .superRefine((value, ctx) => {
    if (isValidIsoWeek(value)) return;
    const last = isoWeeksInYear(value.year);
    ctx.addIssue({
      code: "custom",
      path: ["week"],
      message: `L'année ${value.year} compte ${last} semaines ISO, donc la semaine ${value.week} n'existe pas. La dernière semaine de ${value.year} est la semaine ${last}.`,
    });
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
    .describe(
      "Identifiant du type de repas, tel que renvoyé par la ressource des créneaux.",
    ),
});

export type SlotRefInput = z.infer<typeof slotRefSchema>;

export const mealTypeInputSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9_]+$/, "Clé en minuscules, chiffres et tirets bas.")
    .describe("Clé stable du type de repas, par exemple `dinner`."),
  label: z
    .string()
    .trim()
    .min(1)
    .max(60)
    .describe("Libellé affiché à l'utilisateur."),
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
  defaultTimeBudgetMin: z
    .number()
    .int()
    .min(0)
    .max(600)
    .nullable()
    .default(null),
  varietyPreference: z
    .number()
    .int()
    .min(1)
    .max(5)
    .default(3)
    .describe("1 = j'aime la répétition, 5 = ne jamais répéter un plat."),
  shoppingDay: z
    .number()
    .int()
    .min(1)
    .max(7)
    .nullable()
    .default(null)
    .describe(
      "Jour de courses hebdomadaire, 1 = lundi à 7 = dimanche. Définit le cycle que couvre une liste de courses : sept jours à partir de ce jour, ce jour inclus. Null si la personne n'a rien indiqué.",
    ),
  weeklyBudgetAmount: z.number().min(0).max(100000).nullable().default(null),
  weeklyBudgetCurrency: z
    .string()
    .regex(/^[A-Z]{3}$/, "Code ISO 4217 en trois lettres majuscules, « EUR ».")
    .nullable()
    .default(null)
    .describe(
      "Code de devise ISO 4217, en majuscules : `EUR`, `CHF`, `CAD`. Une longueur de trois caractères ne suffisait pas, elle acceptait `eur` et `1$!`.",
    ),
  agentAuthority: z.enum(AGENT_AUTHORITIES).default("proposal"),
  timeBudgetToleranceMin: z.number().int().min(0).max(120).default(10),
});

export type ProfileInput = z.infer<typeof profileInputSchema>;

/**
 * Every term is trimmed before its length is checked, which matters more here
 * than anywhere else in this file. Untrimmed, `min(1)` accepted `"   "`, so a
 * strict allergen could be stored whose only term was whitespace: it passed
 * validation, it appeared in the profile as an absolute block, and it could
 * never match an ingredient. A rule the user believes protects them and does
 * not is the worst outcome the allergen feature has.
 */
export const allergenInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  severity: z
    .enum(ALLERGEN_SEVERITIES)
    .describe(
      "`strict` est un blocage absolu : aucune recette contenant cet allergène ne peut être placée dans un créneau. `avoid` produit un avertissement.",
    ),
  matches: z
    .array(z.string().trim().min(1).max(80))
    .max(100)
    .default([])
    .describe(
      "Noms et synonymes d'ingrédients qui déclenchent l'allergène. La correspondance est explicite : rien n'est déduit au-delà de cette liste.",
    ),
});

export const exclusionInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  matches: z
    .array(z.string().trim().min(1).max(80))
    .max(100)
    .default([])
    .describe(
      "Noms et synonymes qui déclenchent l'exclusion. Une exclusion produit un avertissement, jamais un blocage.",
    ),
});

export const equipmentInputSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9_]+$/, "Clé en minuscules, chiffres et tirets bas."),
  label: z.string().trim().min(1).max(60).nullable().default(null),
});

export const factInputSchema = z.object({
  category: z
    .enum(FACT_CATEGORIES)
    .describe(
      "Catégorie du fait. `taste` pour les goûts, `organization` pour le rythme et les habitudes de la semaine, `pantry_habit` pour les placards, `social` pour les repas partagés, `health` pour les contraintes de santé non allergiques, `equipment` et `technique` pour la cuisine elle-même, `other` quand aucune ne convient. `other` est aussi la valeur par défaut, mais un fait bien classé est un fait qui ressort dans la bonne section du profil : préférez une catégorie précise.",
    ),
  statement: z
    .string()
    .trim()
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

/**
 * Only the outcome is required. Everything else is optional because a prompt
 * that demands a rating and a note is a prompt people stop answering, and an
 * unanswered prompt teaches nothing.
 */
const feedbackFieldsSchema = z.object({
  outcome: z
    .enum(FEEDBACK_OUTCOMES)
    .describe(
      "`cooked` si le plat a été cuisiné, `skipped` s'il a été sauté, `swapped` si autre chose a été mangé à la place.",
    ),
  swappedFor: z
    .string()
    .max(200)
    .nullable()
    .default(null)
    .describe(
      "Ce qui a été mangé à la place. Souvent plus instructif qu'une note : c'est vers quoi la personne se tourne quand le plan ne tient pas.",
    ),
  rating: z.number().int().min(1).max(5).nullable().default(null),
  note: z.string().max(1000).nullable().default(null),
  tookLonger: z
    .boolean()
    .default(false)
    .describe(
      "Le plat a pris plus de temps que prévu. C'est ce drapeau qui, répété, fait proposer un budget de temps plus réaliste pour ce créneau.",
    ),
  portionIssue: z
    .enum(PORTION_ISSUES)
    .nullable()
    .default(null)
    .describe("`too_much` ou `too_little` si les quantités étaient à côté."),
});

/**
 * The fields that only make sense for one outcome, cross-checked.
 *
 * Nothing enforced this, so `{ outcome: "cooked", swappedFor: "pizza" }` and
 * `{ outcome: "skipped", rating: 5 }` were both storable, and each is a record
 * that contradicts itself. That matters beyond tidiness: these rows are the
 * evidence the signals in src/domain/signals.ts are derived from, and a rating
 * on a meal nobody ate is a rating of nothing.
 *
 * `swapped` without a `swappedFor` is allowed on purpose. What was eaten
 * instead is the single most useful field in the table, and it is also the one
 * people leave blank, so demanding it would cost the outcome as well.
 */
export const feedbackInputSchema = feedbackFieldsSchema.superRefine(
  (value, ctx) => {
    if (value.swappedFor !== null && value.outcome !== "swapped") {
      ctx.addIssue({
        code: "custom",
        path: ["swappedFor"],
        message: `« ${value.swappedFor} » a été indiqué comme mangé à la place, mais le résultat est « ${value.outcome} ». Utilisez outcome = "swapped" pour un plat remplacé, ou laissez swappedFor à null.`,
      });
    }

    if (value.rating !== null && value.outcome !== "cooked") {
      ctx.addIssue({
        code: "custom",
        path: ["rating"],
        message: `Une note ne s'applique qu'à un plat cuisiné, et le résultat est « ${value.outcome} ». Retirez la note, ou indiquez outcome = "cooked" si le plat a bien été cuisiné.`,
      });
    }

    if (value.portionIssue !== null && value.outcome !== "cooked") {
      ctx.addIssue({
        code: "custom",
        path: ["portionIssue"],
        message: `Un problème de quantité ne s'observe qu'à table, et le résultat est « ${value.outcome} ». Retirez portionIssue, ou indiquez outcome = "cooked".`,
      });
    }

    if (value.tookLonger && value.outcome !== "cooked") {
      ctx.addIssue({
        code: "custom",
        path: ["tookLonger"],
        message: `Un plat qui n'a pas été cuisiné n'a pas pris plus de temps que prévu, et le résultat est « ${value.outcome} ». Laissez tookLonger à false.`,
      });
    }
  },
);

export type FeedbackInput = z.infer<typeof feedbackInputSchema>;

/**
 * A calendar date, `AAAA-MM-JJ`, that exists.
 *
 * The regex alone accepted `2026-13-45`, which the `date` column then refused
 * with a Postgres error rather than a validation message. The refinement
 * round-trips through `Date.UTC` and compares the parts back, which is the same
 * check `parseCycleStart` in src/domain/shopping.ts already does, and rejects
 * both an impossible month and a day the month does not have: `2026-02-30`
 * would otherwise roll silently into March.
 */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date au format AAAA-MM-JJ.")
  .refine(
    (value) => {
      const [year, month, day] = value.split("-").map(Number);
      if (year === undefined || month === undefined || day === undefined) {
        return false;
      }
      const date = new Date(Date.UTC(year, month - 1, day));
      return (
        date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day
      );
    },
    { message: "Cette date n'existe pas dans le calendrier." },
  );

export const pantryItemInputSchema = z.object({
  kind: z
    .enum(PANTRY_KINDS)
    .describe(
      "`staple` pour ce qui est toujours là et n'a pas besoin d'être acheté, `use_soon` pour ce qu'il faut manger avant que ça ne se perde.",
    ),
  name: z.string().trim().min(1).max(120),
  quantityNote: z
    .string()
    .max(120)
    .nullable()
    .default(null)
    .describe(
      "Quantité en texte libre, « un demi-paquet », « il en reste peu ». Volontairement pas un nombre : compter mène à une comptabilité que personne ne tient.",
    ),
  expiresOn: isoDateSchema
    .nullable()
    .default(null)
    .describe(
      "Date limite, au format AAAA-MM-JJ. Surtout utile pour `use_soon`.",
    ),
});

export type PantryItemInput = z.infer<typeof pantryItemInputSchema>;

export type IsoDateInput = z.infer<typeof isoDateSchema>;

export const ingredientInputSchema = z.object({
  canonicalName: z.string().trim().min(1).max(120),
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
    .trim()
    .min(1)
    .max(200)
    .describe("Nom de l'ingrédient tel qu'il est écrit dans la recette."),
  note: z.string().max(200).nullable().default(null),
  optional: z
    .boolean()
    .default(false)
    .describe(
      "Un ingrédient optionnel est exclu de la liste de courses par défaut.",
    ),
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
  text: z.string().trim().min(1).max(4000),
  durationMin: z.number().int().min(0).max(1440).nullable().default(null),
  unattended: z
    .boolean()
    .default(false)
    .describe(
      "Une étape non surveillée (four, repos) ne compte pas dans le temps actif, qui est ce que le budget d'un créneau contraint.",
    ),
});

export const recipeInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(4000).nullable().default(null),
  imageUrl: z
    .url()
    .max(2000)
    .refine((value) => value.startsWith("https://"), {
      message: "L'adresse d'une image doit être en https.",
    })
    .nullable()
    .default(null)
    .describe(
      "Adresse https d'une photo du plat. L'image n'est pas copiée sur le serveur : elle est chargée depuis son site d'origine, qui voit donc la visite.",
    ),
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
    .describe(
      "La recette se double et se conserve, donc elle peut servir de session de batch.",
    ),
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
  notCookedInWeeks: z
    .number()
    .int()
    .min(1)
    .max(104)
    .optional()
    .describe(
      "Ne renvoie que les recettes qui n'ont pas été réellement cuisinées depuis N semaines, d'après les retours enregistrés. Une recette jamais cuisinée passe le filtre. À distinguer de `notPlannedInWeeks`, qui porte sur ce qui a été planifié.",
    ),
  minRating: z
    .number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .describe(
      "Note moyenne minimale, sur les repas notés. Une recette jamais notée est exclue : l'absence de note n'est pas une bonne note.",
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
    .trim()
    .min(1)
    .max(40)
    .describe(
      "Clé du type de repas, par exemple `dinner`. Les clés valides sont dans la ressource `cooking://slots`.",
    ),
  recipeRef: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .describe(
      "Identifiant d'une recette existante, ou `temp_id` d'une recette décrite dans `newRecipes` du même appel.",
    ),
  servings: z.number().int().min(1).max(50).nullable().default(null),
  note: z.string().max(500).nullable().default(null),
  /**
   * Deliberately **not** `.trim().min(1)`, unlike every other required string
   * in this file.
   *
   * A blank rationale is caught by `validateWeek`, which raises
   * `MISSING_RATIONALE`: a documented code carrying the slot, the recipe title
   * and a sentence explaining what a justification is for. Trimming here
   * intercepts the same input one layer earlier and answers `VALIDATION`
   * "expected string to have >=1 characters" instead, which is true, generic,
   * and useless to the one reader who cannot ask a follow-up question.
   *
   * The rule is also conditional in a way a schema cannot express: it applies
   * to an entry an agent is introducing, not to one a user typed by hand and
   * not to one inherited from a previous version. So it belongs in the writer.
   */
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
    .trim()
    .min(1)
    .max(100)
    .describe(
      "Identifiant temporaire, utilisé par `recipeRef` dans les entrées du même appel. Il n'est pas conservé.",
    ),
});

/**
 * Built by extending `isoWeekSchema` rather than redeclaring `year` and `week`,
 * so the week-53 refinement applies here too. It used to spell both fields out
 * again, which meant the one schema that agents actually write weeks through
 * was the one without the validity check.
 */
export const proposeWeekSchema = isoWeekSchema.extend({
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
  prepLinks: z
    .array(
      z.object({
        sourceIndex: z
          .number()
          .int()
          .min(0)
          .describe("Position dans `entries` du repas réellement cuisiné."),
        dependentIndex: z
          .number()
          .int()
          .min(0)
          .describe(
            "Position dans `entries` du repas qui n'est qu'un réchauffage.",
          ),
        servingsDrawn: z.number().int().min(1).max(50).nullable().default(null),
        note: z.string().max(500).nullable().default(null),
      }),
    )
    .max(20)
    .default([])
    .describe(
      "Sessions de cuisine qui servent plusieurs repas : « on double dimanche, on remange mardi ». C'est ce qui rend utilisable un créneau au budget très serré. La session doit être le même jour ou avant.",
    ),
});

export type ProposeWeekInput = z.infer<typeof proposeWeekSchema>;

/**
 * The grid as it was when a version was created, stored on the version so that
 * changing slot configuration later never rewrites history.
 *
 * This is also the `$type` of the `plan_version.slot_snapshot` jsonb column, so
 * the shape a reader gets back and the shape a writer is validated against are
 * one declaration. Parse a snapshot on read rather than trusting the column
 * type: `$type` is a compile-time claim about a jsonb value, and a row written
 * before a shape change would satisfy the type and not the schema.
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

/**
 * A line the user typed on the grocery list themselves, rather than one derived
 * from the plan. It shops exactly as written and merges with nothing: a name a
 * person typed is not evidence about any ingredient in the vocabulary.
 */
export const manualLineInputSchema = z.object({
  displayName: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe(
      "Le produit à acheter, tel qu'il doit apparaître sur la liste. C'est le nom du produit, pas celui d'un ingrédient du vocabulaire : « sacs poubelle » et « coulis de tomate » sont l'un et l'autre valides.",
    ),
  quantity: z
    .number()
    .positive()
    .max(100000)
    .nullable()
    .default(null)
    .describe(
      "Quantité, strictement positive, ou null quand il n'y a rien à compter. Une quantité de zéro n'a pas de sens sur une liste de courses : pour ne pas acheter quelque chose, n'ajoutez pas la ligne.",
    ),
  unit: z
    .string()
    .trim()
    .max(20)
    .nullable()
    .default(null)
    .describe(
      `Unité de la quantité. Unités canoniques : ${UNIT_VALUES.join(", ")}. Une unité inconnue est conservée telle quelle.`,
    ),
  aisle: z
    .string()
    .trim()
    .max(60)
    .nullable()
    .default(null)
    .describe(
      "Rayon, qui décide de l'ordre de la liste. Reprenez un rayon déjà utilisé par les autres lignes plutôt que d'en inventer un, sans quoi la ligne se retrouve seule en fin de liste.",
    ),
  note: z
    .string()
    .trim()
    .max(200)
    .nullable()
    .default(null)
    .describe("Précision libre : une marque, un format, « le grand paquet »."),
});

export type ManualLineInput = z.infer<typeof manualLineInputSchema>;

/**
 * One cooking session feeding one later meal. The two entries are named by id
 * rather than by slot, because a slot can hold several dishes.
 */
export const prepLinkInputSchema = z.object({
  sourceEntryId: z
    .uuid()
    .describe(
      "Identifiant de l'entrée réellement cuisinée, celle où le temps de cuisine est passé. Elle doit tomber le même jour que le repas dépendant ou avant : on ne mange pas mardi ce qu'on cuisine jeudi.",
    ),
  dependentEntryId: z
    .uuid()
    .describe(
      "Identifiant de l'entrée qui n'est qu'un réchauffage. C'est ce qui rend tenable un créneau au budget de temps très serré.",
    ),
  servingsDrawn: z
    .number()
    .int()
    .min(1)
    .max(50)
    .nullable()
    .default(null)
    .describe(
      "Portions prélevées sur la session pour ce repas. Elles s'ajoutent aux portions de la session : la liste de courses achète les ingrédients de la somme des deux. `null` pour reprendre les portions du repas dépendant.",
    ),
  note: z
    .string()
    .trim()
    .max(500)
    .nullable()
    .default(null)
    .describe(
      "Précision sur la conservation ou le réchauffage, « au four 20 min », « à congeler ».",
    ),
});

export type PrepLinkInput = z.infer<typeof prepLinkInputSchema>;

/**
 * The two fields of a planned meal that can change without changing which dish
 * is in the slot. Anything else is a new entry, and a new plan version with it.
 *
 * At least one key is required: an empty patch would create a plan version that
 * differs from its parent in nothing, and versions are immutable, so the
 * history would fill with rows recording that nothing happened.
 */
export const planEntryPatchSchema = z
  .object({
    servings: z
      .number()
      .int()
      .min(1)
      .max(50)
      .describe("Nouveau nombre de portions pour ce repas."),
    note: z
      .string()
      .trim()
      .max(500)
      .describe(
        "Nouvelle note libre sur ce repas. Une chaîne vide l'effacerait.",
      ),
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message:
      "Indiquez au moins `servings` ou `note`. Une modification vide créerait une version de plan identique à la précédente.",
  });

export type PlanEntryPatch = z.infer<typeof planEntryPatchSchema>;

/** Paging over the agent activity log, which is append-only and can be long. */
export const activityQuerySchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(50)
    .describe("Nombre d'entrées à renvoyer, de 1 à 100. 50 par défaut."),
  offset: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe(
      "Nombre d'entrées à sauter, les plus récentes d'abord. Le journal est en ajout seul, donc une page reste stable sauf pour les entrées écrites entre deux appels.",
    ),
});

export type ActivityQuery = z.infer<typeof activityQuerySchema>;
