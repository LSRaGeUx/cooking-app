import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  foreignKey,
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
    aliases: text("aliases")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    category: text("category").notNull().default("other"),
    aisle: text("aisle"),
    defaultUnit: text("default_unit"),
    // Enables volume to mass conversion during grocery merging (phase 2).
    densityGPerMl: numeric("density_g_per_ml", { precision: 10, scale: 4 }),
    allergenIds: uuid("allergen_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
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
    tags: text("tags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    cuisine: text("cuisine"),
    mainProtein: text("main_protein"),
    difficulty: text("difficulty"),
    equipmentKeys: text("equipment_keys")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /**
     * **No longer maintained. Do not read it.**
     *
     * This was a cache of the allergens derived from the linked ingredients,
     * refreshed only when the recipe itself was created or updated. Adding or
     * removing an allergen left every recipe's copy stale, so a listing showed a
     * recipe as clean while assignment correctly blocked it, which is the worst
     * shape a safety-relevant cache can take. Allergens are now derived at read
     * time, and no code writes or reads this column.
     *
     * It is kept rather than dropped because a deploy rolls back by re-running an
     * earlier `sha-<commit>` image, and those images still select it. Dropping
     * the column would turn a rollback into an outage. Drop it once no image in
     * play still names it.
     */
    allergenIds: uuid("allergen_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    revision: integer("revision").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    // Maintained by Postgres so search can never drift from the row. French
    // configuration because the UI and the recipes are French.
    // Tags are deliberately not in the vector: array_to_string is STABLE, not
    // IMMUTABLE, so Postgres refuses it in a generated column. Tags are a set
    // filter rather than free text anyway, and get their own GIN index below.
    //
    // **It covers the title and the description, and nothing else.** Searching
    // for an ingredient word finds nothing: ingredient names live in
    // recipe_ingredient, another table, and a generated column can only read
    // the row it belongs to. Getting them in would mean a trigger maintaining a
    // denormalized column, or a materialized view, and neither is worth it
    // before someone asks. What it does mean is that the recipe search tool's
    // description must say so, because an agent that searches "poulet" and gets
    // nothing back concludes the library has no chicken recipes rather than
    // that it searched the wrong field. See src/mcp/tools/search-recipes.ts.
    searchVector: tsvector("search_vector").generatedAlwaysAs(
      sql`to_tsvector('french', coalesce(title, '') || ' ' || coalesce(description, ''))`,
    ),
  },
  (t) => [
    // Partial on the live rows. Every listing, search and count filters
    // `deleted_at is null`, so the deleted rows were index entries nothing ever
    // looked at, and excluding them keeps the index the size of the library
    // rather than the size of its whole history.
    index("recipe_user_idx")
      .on(t.userId)
      .where(sql`deleted_at is null`),
    // The target of the child tables' composite foreign keys. See the note on
    // `recipe_ingredient` below: `id` alone is already unique, and this exists
    // so that `(recipe_id, user_id)` has something to reference.
    unique("recipe_id_user_key").on(t.id, t.userId),
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
 *
 * **`user_id` is tied to the parent's by a composite foreign key.** It is
 * denormalized so the RLS policy is a column comparison rather than a subquery
 * on every row, and for a while nothing connected the two: the foreign key
 * named `recipe_id` alone, so a row could carry one tenant's `user_id` and
 * another tenant's `recipe_id` and satisfy every constraint. Nothing writes
 * that today, because every parent id is resolved under `withUser` before a
 * child row is written, but foreign key checks run as the table owner and
 * bypass row-level security, so RLS is not what was stopping it either: the
 * only guard was that the services happen to be careful.
 *
 * `(recipe_id, user_id) references recipe(id, user_id)` makes it structural.
 * The cost is the `recipe_id_user_key` unique constraint on the parent, which
 * is redundant as a uniqueness claim and exists purely as the reference target.
 */
export const recipeIngredient = pgTable(
  "recipe_ingredient",
  {
    id: primaryId(),
    userId: ownerId(),
    recipeId: uuid("recipe_id").notNull(),
    position: smallint("position").notNull().default(0),
    quantity: numeric("quantity", { precision: 12, scale: 3 }),
    unit: text("unit"),
    rawName: text("raw_name").notNull(),
    // Nullable, and left as a single-column reference on purpose. A composite
    // key here would have to be `on delete set null`, and Postgres sets every
    // referencing column, which would mean nulling `user_id` on a row where it
    // is `not null`: deleting an ingredient would fail instead of unlinking it.
    // An `ingredient` row is reachable only under `withUser` in the first
    // place, so the same convention that used to cover `recipe_id` covers this.
    ingredientId: uuid("ingredient_id").references(() => ingredient.id, {
      onDelete: "set null",
    }),
    note: text("note"),
    optional: boolean("optional").notNull().default(false),
  },
  (t) => [
    index("recipe_ingredient_recipe_idx").on(t.recipeId, t.position),
    // The pantry match and the grocery aggregation both group by this column,
    // and the `on delete set null` above scans it whenever a vocabulary entry
    // is removed. Postgres does not index a foreign key column for you.
    index("recipe_ingredient_ingredient_idx").on(t.ingredientId),
    foreignKey({
      columns: [t.recipeId, t.userId],
      foreignColumns: [recipe.id, recipe.userId],
      name: "recipe_ingredient_recipe_user_fk",
    }).onDelete("cascade"),
    ownerPolicy("recipe_ingredient_owner", t.userId),
  ],
).enableRLS();

export const recipeStep = pgTable(
  "recipe_step",
  {
    id: primaryId(),
    userId: ownerId(),
    recipeId: uuid("recipe_id").notNull(),
    position: smallint("position").notNull().default(0),
    text: text("text").notNull(),
    durationMin: smallint("duration_min"),
    // Feeds the active-time computation: unattended minutes do not count.
    unattended: boolean("unattended").notNull().default(false),
  },
  (t) => [
    index("recipe_step_recipe_idx").on(t.recipeId, t.position),
    // Composite, for the reason spelled out on `recipe_ingredient`.
    foreignKey({
      columns: [t.recipeId, t.userId],
      foreignColumns: [recipe.id, recipe.userId],
      name: "recipe_step_recipe_user_fk",
    }).onDelete("cascade"),
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
    recipeId: uuid("recipe_id").notNull(),
    revision: integer("revision").notNull(),
    // Left deliberately loose. Unlike the other jsonb columns, this one holds
    // whatever a recipe looked like at the time, including under a schema this
    // build no longer has a type for, and claiming otherwise would be a lie the
    // compiler believes.
    snapshot: jsonb("snapshot").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("recipe_revision_recipe_revision_key").on(t.recipeId, t.revision),
    // Composite, for the reason spelled out on `recipe_ingredient`.
    foreignKey({
      columns: [t.recipeId, t.userId],
      foreignColumns: [recipe.id, recipe.userId],
      name: "recipe_revision_recipe_user_fk",
    }).onDelete("cascade"),
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
