import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import {
  INGREDIENT_CATEGORIES,
  RECIPE_SOURCES,
  sqlInList,
} from "@/domain/vocabulary";
import {
  createdAt,
  ownerId,
  ownerPolicy,
  primaryId,
  updatedAt,
} from "./_shared";


/** Drizzle has no built-in tsvector, and the search column must be one. */
const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => "tsvector",
});

/**
 * Per-user rather than global, on purpose: a shared vocabulary would need
 * governance nobody is going to do in a self-hosted app, and a user's aisle
 * layout is their own supermarket's. A starter set is seeded per user.
 *
 * Two things depend on this table and neither works without it: grocery list
 * merging ("2 onions" plus "1 oignon jaune" must add up) and allergen
 * derivation.
 */
export const ingredient = pgTable(
  "ingredient",
  {
    id: primaryId(),
    userId: ownerId(),
    canonicalName: text("canonical_name").notNull(),
    aliases: text("aliases").array().notNull().default(sql`'{}'::text[]`),
    category: text("category").notNull().default("other"),
    aisle: text("aisle"),
    defaultUnit: text("default_unit"),
    // Enables volume to mass conversion during grocery merging (phase 2).
    densityGPerMl: numeric("density_g_per_ml", { precision: 10, scale: 4 }),
    allergenIds: uuid("allergen_ids").array().notNull().default(sql`'{}'::uuid[]`),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("ingredient_user_name_key").on(t.userId, t.canonicalName),
    index("ingredient_user_idx").on(t.userId),
    check(
      "ingredient_category_known",
      sql`${t.category} in ${sql.raw(sqlInList(INGREDIENT_CATEGORIES))}`,
    ),
    ownerPolicy("ingredient_owner", t.userId),
  ],
).enableRLS();

/**
 * Soft-deleted, because past plan entries reference it. `revision` is bumped on
 * every edit and the prior state is kept in recipe_revision, which is what
 * makes an agent-driven edit reversible.
 *
 * active_time_min is deliberately separate from prep plus cook: unattended oven
 * time does not consume the user's evening, and the slot time budget is
 * compared against attended time only.
 */
export const recipe = pgTable(
  "recipe",
  {
    id: primaryId(),
    userId: ownerId(),
    title: text("title").notNull(),
    description: text("description"),
    imageUrl: text("image_url"),
    source: text("source").notNull().default("manual"),
    sourceUrl: text("source_url"),
    // Which agent created it. Matches oauthClient.id, which Better Auth types
    // as text, so no foreign key: that table belongs to the other migrator.
    sourceClientId: text("source_client_id"),
    servings: smallint("servings").notNull().default(2),
    prepTimeMin: smallint("prep_time_min"),
    cookTimeMin: smallint("cook_time_min"),
    activeTimeMin: smallint("active_time_min"),
    batchFriendly: boolean("batch_friendly").notNull().default(false),
    keepsDays: smallint("keeps_days"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    cuisine: text("cuisine"),
    mainProtein: text("main_protein"),
    difficulty: text("difficulty"),
    equipmentKeys: text("equipment_keys").array().notNull().default(sql`'{}'::text[]`),
    // Derived from the linked ingredients, user-overridable.
    allergenIds: uuid("allergen_ids").array().notNull().default(sql`'{}'::uuid[]`),
    revision: integer("revision").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    // Maintained by Postgres so search can never drift from the row. French
    // configuration because the UI and the recipes are French.
    // Tags are deliberately not in the vector: array_to_string is STABLE, not
    // IMMUTABLE, so Postgres refuses it in a generated column. Tags are a set
    // filter rather than free text anyway, and get their own GIN index below.
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      sql`to_tsvector('french', coalesce(title, '') || ' ' || coalesce(description, ''))`,
    ),
  },
  (t) => [
    index("recipe_user_idx").on(t.userId),
    index("recipe_search_idx").using("gin", t.searchVector),
    index("recipe_tags_idx").using("gin", t.tags),
    check(
      "recipe_source_known",
      sql`${t.source} in ${sql.raw(sqlInList(RECIPE_SOURCES))}`,
    ),
    check("recipe_servings_positive", sql`${t.servings} > 0`),
    ownerPolicy("recipe_owner", t.userId),
  ],
).enableRLS();

/**
 * `ingredient_id` is nullable on purpose: an unlinked ingredient still displays
 * and still cooks, it only loses merging. Blocking a recipe save on perfect
 * linking would make creation slow, and creation speed is what fills the
 * library.
 */
export const recipeIngredient = pgTable(
  "recipe_ingredient",
  {
    id: primaryId(),
    // Denormalized from the parent recipe so the RLS policy is a column
    // comparison rather than a subquery on every row.
    userId: ownerId(),
    recipeId: uuid("recipe_id")
      .notNull()
      .references(() => recipe.id, { onDelete: "cascade" }),
    position: smallint("position").notNull().default(0),
    quantity: numeric("quantity", { precision: 12, scale: 3 }),
    unit: text("unit"),
    rawName: text("raw_name").notNull(),
    ingredientId: uuid("ingredient_id").references(() => ingredient.id, {
      onDelete: "set null",
    }),
    note: text("note"),
    optional: boolean("optional").notNull().default(false),
  },
  (t) => [
    index("recipe_ingredient_recipe_idx").on(t.recipeId, t.position),
    ownerPolicy("recipe_ingredient_owner", t.userId),
  ],
).enableRLS();

export const recipeStep = pgTable(
  "recipe_step",
  {
    id: primaryId(),
    userId: ownerId(),
    recipeId: uuid("recipe_id")
      .notNull()
      .references(() => recipe.id, { onDelete: "cascade" }),
    position: smallint("position").notNull().default(0),
    text: text("text").notNull(),
    durationMin: smallint("duration_min"),
    // Feeds the active-time computation: unattended minutes do not count.
    unattended: boolean("unattended").notNull().default(false),
  },
  (t) => [
    index("recipe_step_recipe_idx").on(t.recipeId, t.position),
    ownerPolicy("recipe_step_owner", t.userId),
  ],
).enableRLS();

/**
 * Cheap insurance for agent-driven edits: the whole prior recipe as jsonb, one
 * row per superseded revision.
 */
export const recipeRevision = pgTable(
  "recipe_revision",
  {
    id: primaryId(),
    userId: ownerId(),
    recipeId: uuid("recipe_id")
      .notNull()
      .references(() => recipe.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("recipe_revision_recipe_revision_key").on(t.recipeId, t.revision),
    ownerPolicy("recipe_revision_owner", t.userId),
  ],
).enableRLS();

export type Ingredient = typeof ingredient.$inferSelect;
export type NewIngredient = typeof ingredient.$inferInsert;
export type Recipe = typeof recipe.$inferSelect;
export type NewRecipe = typeof recipe.$inferInsert;
export type RecipeIngredient = typeof recipeIngredient.$inferSelect;
export type NewRecipeIngredient = typeof recipeIngredient.$inferInsert;
export type RecipeStep = typeof recipeStep.$inferSelect;
export type NewRecipeStep = typeof recipeStep.$inferInsert;
export type RecipeRevision = typeof recipeRevision.$inferSelect;
