/**
 * The controlled vocabularies of the domain, in one place because three
 * consumers must never disagree about them: the Postgres check constraints, the
 * Zod schemas that validate both entry points, and the enum values an agent
 * reads in a tool description.
 *
 * They live in `domain` rather than next to the tables so the dependency runs
 * one way only: the database schema imports the vocabulary, never the reverse.
 */

export const DIETS = [
  "none",
  "vegetarian",
  "vegan",
  "pescatarian",
  "halal",
  "kosher",
] as const;
export type Diet = (typeof DIETS)[number];

export const ALLERGEN_SEVERITIES = ["avoid", "strict"] as const;
export type AllergenSeverityValue = (typeof ALLERGEN_SEVERITIES)[number];

export const AGENT_AUTHORITIES = ["proposal", "direct"] as const;
export type AgentAuthority = (typeof AGENT_AUTHORITIES)[number];

export const SLOT_STATES = ["planned", "skipped", "hidden"] as const;

/** The starter grid every new user is seeded with. Extensible per user. */
export const STARTER_MEAL_TYPES = [
  { key: "breakfast", label: "Petit-déjeuner", sortOrder: 0 },
  { key: "lunch", label: "Déjeuner", sortOrder: 1 },
  { key: "dinner", label: "Dîner", sortOrder: 2 },
] as const;

export const INGREDIENT_CATEGORIES = [
  "produce",
  "dairy",
  "meat",
  "fish",
  "dry_goods",
  "spice",
  "frozen",
  "other",
] as const;
export type IngredientCategory = (typeof INGREDIENT_CATEGORIES)[number];

export const RECIPE_SOURCES = ["manual", "agent", "import"] as const;
export type RecipeSource = (typeof RECIPE_SOURCES)[number];

export const PLAN_VERSION_STATES = [
  "pending",
  "active",
  "superseded",
  "rejected",
] as const;
export type PlanVersionState = (typeof PLAN_VERSION_STATES)[number];

export const PLAN_AUTHORS = ["user", "agent"] as const;
export type PlanAuthor = (typeof PLAN_AUTHORS)[number];

/**
 * The controlled equipment vocabulary. Controlled so a recipe can declare a
 * requirement that is comparable across users, and extensible because no list
 * survives contact with a real kitchen: anything the user adds is stored with
 * its own key and its own label.
 */
export const EQUIPMENT_VOCABULARY = [
  { key: "oven", label: "Four" },
  { key: "hob", label: "Plaques de cuisson" },
  { key: "microwave", label: "Micro-ondes" },
  { key: "freezer", label: "Congélateur" },
  { key: "blender", label: "Blender" },
  { key: "food_processor", label: "Robot ménager" },
  { key: "stand_mixer", label: "Robot pâtissier" },
  { key: "pressure_cooker", label: "Cocotte-minute" },
  { key: "slow_cooker", label: "Mijoteuse" },
  { key: "air_fryer", label: "Friteuse à air" },
  { key: "wok", label: "Wok" },
  { key: "cast_iron", label: "Cocotte en fonte" },
  { key: "grill", label: "Gril" },
  { key: "steamer", label: "Cuit-vapeur" },
  { key: "scale", label: "Balance de cuisine" },
  { key: "thermometer", label: "Thermomètre de cuisson" },
] as const;

export const FACT_CATEGORIES = [
  "taste",
  "organization",
  "pantry_habit",
  "social",
  "health",
  "equipment",
  "technique",
  "other",
] as const;
export type FactCategory = (typeof FACT_CATEGORIES)[number];

export const FACT_POLARITIES = ["positive", "negative", "neutral"] as const;
export type FactPolarity = (typeof FACT_POLARITIES)[number];

export const FACT_CONFIDENCES = ["low", "medium", "high"] as const;
export type FactConfidence = (typeof FACT_CONFIDENCES)[number];

export const FACT_SOURCES = ["user", "agent", "feedback_inference"] as const;
export type FactSource = (typeof FACT_SOURCES)[number];

/**
 * Only a human moves a fact to `confirmed`. An agent's write always lands as
 * `unconfirmed`, whatever it asked for: the fact store is the moat, and
 * poisoning it is the top product risk.
 */
export const FACT_STATUSES = ["unconfirmed", "confirmed", "retired"] as const;
export type FactStatus = (typeof FACT_STATUSES)[number];

/** One assertion per fact. The cap is what keeps them atomic. */
export const FACT_STATEMENT_MAX_LENGTH = 280;

/** Active facts per user. Past it, the user is asked to prune. */
export const DEFAULT_FACT_CAP = 300;

/**
 * `draft` is a list generated from a proposal the user has not accepted, which
 * the screen labels as such. `active` is the list you shop from. `archived` is
 * kept for history.
 */
export const GROCERY_LIST_STATES = ["draft", "active", "archived"] as const;
export type GroceryListState = (typeof GROCERY_LIST_STATES)[number];

/**
 * What actually happened in a slot. `swapped` carries what was eaten instead,
 * which is often more informative than a rating: it says what the person
 * reached for when the plan did not survive the day.
 */
export const FEEDBACK_OUTCOMES = ["cooked", "skipped", "swapped"] as const;
export type FeedbackOutcome = (typeof FEEDBACK_OUTCOMES)[number];

export const PORTION_ISSUES = ["too_much", "too_little"] as const;
export type PortionIssue = (typeof PORTION_ISSUES)[number];

/**
 * `staple` is always in the cupboard and is left off the grocery list.
 * `use_soon` is something to eat before it goes, and is a planning priority.
 */
export const PANTRY_KINDS = ["staple", "use_soon"] as const;
export type PantryKind = (typeof PANTRY_KINDS)[number];

export const PANTRY_SOURCES = ["user", "agent"] as const;

/** `derived` lines come from the plan, `manual` ones the user typed. */
export const GROCERY_LINE_ORIGINS = ["derived", "manual"] as const;
export type GroceryLineOrigin = (typeof GROCERY_LINE_ORIGINS)[number];

/** Renders a readonly string tuple as a SQL `in` list literal. */
export function sqlInList(values: readonly string[]): string {
  return `(${values.map((value) => `'${value.replace(/'/g, "''")}'`).join(", ")})`;
}
