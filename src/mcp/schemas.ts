import { z } from "zod";
import {
  isoWeekSchema,
  newRecipeSchema,
  pantryItemInputSchema,
  proposeWeekSchema,
  proposedEntrySchema,
  recipeIngredientInputSchema,
  recipeInputSchema,
  recipeStepInputSchema,
} from "@/domain/schemas";

/**
 * The wire shape of every MCP parameter that is shared by more than one tool.
 *
 * **Why this file exists at all.** Two naming conventions used to coexist on one
 * agent surface. A tool that declared its own fields spelled them snake_case
 * (`update_slot` takes `day_of_week`, `rationale_refs`), and a tool that spread
 * a domain schema straight into `inputSchema` published the domain's camelCase
 * (`propose_week` took `dayOfWeek`, `newRecipes`, `expectedBaseVersion`), while
 * `update_recipe` managed both in one object: `recipe_id` beside
 * `activeTimeMin`. An agent that learned `day_of_week` from one tool sends it to
 * the other and gets `VALIDATION` for a parameter it spelled the way this same
 * server taught it. The surface is now snake_case everywhere, and camelCase
 * stops at this boundary.
 *
 * **How the duplication is kept honest.** Each field below reuses the domain
 * field schema under a renamed key, so the bounds, the enums and the
 * `.describe()` product copy have one definition and cannot drift. Only a
 * description that names another parameter is rewritten, because such a
 * description has to spell that parameter the way the agent will.
 *
 * **These schemas validate the wire, the domain schema validates the rule.**
 * Every handler maps its arguments here and then parses the result through the
 * real domain schema. That is not belt and braces, it is required: the MCP SDK
 * rebuilds its own object from the `.shape` it is handed, which drops any
 * object-level refinement. `isoWeekSchema` carries a `superRefine` refusing a
 * week the year does not have, so a tool that only spread the shape accepted
 * `2027-W53` and was refused several layers deeper, with an error about a plan
 * rather than about a week. Parsing through the domain schema in the handler is
 * what makes the object-level rules run at the edge.
 */

const recipeFields = recipeInputSchema.shape;
const ingredientFields = recipeIngredientInputSchema.shape;
const stepFields = recipeStepInputSchema.shape;
const entryFields = proposedEntrySchema.shape;
const weekFields = proposeWeekSchema.shape;
const pantryFields = pantryItemInputSchema.shape;

export const ingredientLineParamsSchema = z.object({
  quantity: ingredientFields.quantity.describe(
    "Quantité numérique, ou `null` quand la recette n'en donne pas (« une pincée »).",
  ),
  unit: ingredientFields.unit,
  raw_name: ingredientFields.rawName,
  note: ingredientFields.note.describe(
    "Précision de préparation, « émincé », « à température ambiante ».",
  ),
  optional: ingredientFields.optional,
  ingredient_id: ingredientFields.ingredientId,
});

export const recipeStepParamsSchema = z.object({
  text: stepFields.text.describe("L'étape, en une instruction."),
  duration_min: stepFields.durationMin.describe(
    "Durée de l'étape en minutes, ou `null` si elle n'est pas chronométrée.",
  ),
  unattended: stepFields.unattended,
});

/** `create_recipe`, `update_recipe`, and the `new_recipes` of `propose_week`. */
export const recipeParamsSchema = z.object({
  title: recipeFields.title.describe(
    "Nom du plat, tel qu'il apparaîtra dans la bibliothèque.",
  ),
  description: recipeFields.description.describe(
    "Ce que c'est, en une ou deux phrases. C'est ce que la recherche plein texte indexe, avec le titre.",
  ),
  image_url: recipeFields.imageUrl,
  servings: recipeFields.servings,
  prep_time_min: recipeFields.prepTimeMin.describe(
    "Minutes de préparation avant cuisson.",
  ),
  cook_time_min: recipeFields.cookTimeMin.describe("Minutes de cuisson."),
  active_time_min: recipeFields.activeTimeMin,
  batch_friendly: recipeFields.batchFriendly,
  keeps_days: recipeFields.keepsDays.describe(
    "Nombre de jours de conservation d'un reste. C'est ce qui dit si une session de cuisine peut servir un repas plus tard dans la semaine.",
  ),
  tags: recipeFields.tags.describe(
    "Étiquettes libres, utilisées comme filtre par `search_recipes`. Reprenez celles déjà présentes dans la bibliothèque plutôt que d'en inventer.",
  ),
  cuisine: recipeFields.cuisine.describe(
    "Cuisine d'origine, « italienne », « thaïe ».",
  ),
  main_protein: recipeFields.mainProtein.describe(
    "Protéine principale, « poulet », « lentilles ». Sert à équilibrer une semaine et à filtrer une recherche.",
  ),
  difficulty: recipeFields.difficulty.describe("Difficulté en texte libre."),
  equipment_keys: recipeFields.equipmentKeys.describe(
    "Clés d'équipement requis, telles qu'elles apparaissent dans la section équipement du profil. Un équipement absent du profil produit un avertissement, jamais un blocage.",
  ),
  ingredients: z
    .array(ingredientLineParamsSchema)
    .max(100)
    .default([])
    .describe("Tous les ingrédients, dans l'ordre de la recette."),
  steps: z
    .array(recipeStepParamsSchema)
    .max(100)
    .default([])
    .describe("Toutes les étapes, dans l'ordre."),
});

export type RecipeParams = z.infer<typeof recipeParamsSchema>;

/** As a recipe, plus the handle the entries of the same call refer to it by. */
export const newRecipeParamsSchema = recipeParamsSchema.extend({
  temp_id: newRecipeSchema.shape.tempId.describe(
    "Identifiant temporaire, utilisé par `recipe_ref` dans les entrées du même appel. Il n'est pas conservé.",
  ),
});

export const proposedEntryParamsSchema = z.object({
  day_of_week: entryFields.dayOfWeek,
  meal_type: entryFields.mealType,
  recipe_ref: entryFields.recipeRef.describe(
    "Identifiant d'une recette existante, ou `temp_id` d'une recette décrite dans `new_recipes` du même appel.",
  ),
  servings: entryFields.servings.describe(
    "Portions pour ce repas, ou `null` pour reprendre celles du créneau puis celles du profil.",
  ),
  note: entryFields.note.describe(
    "Note libre affichée avec le repas, « prévoir du pain ».",
  ),
  rationale: entryFields.rationale,
  rationale_refs: entryFields.rationaleRefs,
});

export const prepLinkIndexParamsSchema = z.object({
  source_index: z
    .number()
    .int()
    .min(0)
    .describe("Position dans `entries` du repas réellement cuisiné."),
  dependent_index: z
    .number()
    .int()
    .min(0)
    .describe("Position dans `entries` du repas qui n'est qu'un réchauffage."),
  servings_drawn: z
    .number()
    .int()
    .min(1)
    .max(50)
    .nullable()
    .default(null)
    .describe(
      "Portions prélevées sur la session pour ce repas. `null` pour reprendre les portions du repas dépendant.",
    ),
  note: z
    .string()
    .max(500)
    .nullable()
    .default(null)
    .describe("Précision de conservation ou de réchauffage."),
});

/** Shared by `propose_week` and its dry run, `check_feasibility`. */
export const proposeWeekParamsSchema = z.object({
  year: isoWeekSchema.shape.year,
  week: isoWeekSchema.shape.week,
  expected_base_version: weekFields.expectedBaseVersion,
  summary: weekFields.summary,
  new_recipes: z
    .array(newRecipeParamsSchema)
    .max(20)
    .default([])
    .describe(
      "Recettes à créer dans le même appel. Elles sont créées et assignées en une seule transaction : si une entrée est refusée, aucune recette n'est créée.",
    ),
  entries: z
    .array(proposedEntryParamsSchema)
    .min(1)
    .max(50)
    .describe("Les repas de la semaine, un par créneau à remplir."),
  prep_links: z
    .array(prepLinkIndexParamsSchema)
    .max(20)
    .default([])
    .describe(
      "Sessions de cuisine qui servent plusieurs repas : « on double dimanche, on remange mardi ». C'est ce qui rend utilisable un créneau au budget très serré. La session doit être le même jour ou avant.",
    ),
});

export type ProposeWeekParams = z.infer<typeof proposeWeekParamsSchema>;

export const pantryItemParamsSchema = z.object({
  kind: pantryFields.kind,
  name: pantryFields.name.describe(
    "Le produit, tel que la personne en parle. « chou », « pâtes ».",
  ),
  quantity_note: pantryFields.quantityNote,
  expires_on: pantryFields.expiresOn,
});

export type PantryItemParams = z.infer<typeof pantryItemParamsSchema>;

/**
 * The mappers. One per schema above, and the only place a snake_case key becomes
 * a camelCase one. The result is handed to the matching domain schema, never to
 * a service directly, so an omission here fails validation rather than writing a
 * row with a defaulted field nobody asked for.
 */

export function toRecipeInput(params: RecipeParams) {
  return {
    title: params.title,
    description: params.description,
    imageUrl: params.image_url,
    servings: params.servings,
    prepTimeMin: params.prep_time_min,
    cookTimeMin: params.cook_time_min,
    activeTimeMin: params.active_time_min,
    batchFriendly: params.batch_friendly,
    keepsDays: params.keeps_days,
    tags: params.tags,
    cuisine: params.cuisine,
    mainProtein: params.main_protein,
    difficulty: params.difficulty,
    equipmentKeys: params.equipment_keys,
    ingredients: params.ingredients.map((line) => ({
      quantity: line.quantity,
      unit: line.unit,
      rawName: line.raw_name,
      note: line.note,
      optional: line.optional,
      ingredientId: line.ingredient_id,
    })),
    steps: params.steps.map((step) => ({
      text: step.text,
      durationMin: step.duration_min,
      unattended: step.unattended,
    })),
  };
}

export function toProposeWeekInput(params: ProposeWeekParams) {
  return {
    year: params.year,
    week: params.week,
    expectedBaseVersion: params.expected_base_version,
    summary: params.summary,
    newRecipes: params.new_recipes.map((recipe) => ({
      ...toRecipeInput(recipe),
      tempId: recipe.temp_id,
    })),
    entries: params.entries.map((entry) => ({
      dayOfWeek: entry.day_of_week,
      mealType: entry.meal_type,
      recipeRef: entry.recipe_ref,
      servings: entry.servings,
      note: entry.note,
      rationale: entry.rationale,
      rationaleRefs: entry.rationale_refs,
    })),
    prepLinks: params.prep_links.map((link) => ({
      sourceIndex: link.source_index,
      dependentIndex: link.dependent_index,
      servingsDrawn: link.servings_drawn,
      note: link.note,
    })),
  };
}

export function toPantryItemInput(params: PantryItemParams) {
  return {
    kind: params.kind,
    name: params.name,
    quantityNote: params.quantity_note,
    expiresOn: params.expires_on,
  };
}
