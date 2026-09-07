import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  numeric,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  GROCERY_LINE_ORIGINS,
  GROCERY_LIST_STATES,
  sqlInList,
} from "@/domain/vocabulary";
import {
  createdAt,
  ownerId,
  ownerPolicy,
  primaryId,
  updatedAt,
} from "./_shared";
import { planVersion } from "./plans";
import { ingredient } from "./recipes";

/**
 * A snapshot, not a view. The user shops from this list while the plan may keep
 * moving, so it is written down and then edited in place rather than recomputed
 * on every read.
 *
 * A list belongs to a shopping cycle, so its identity is the date it starts on.
 * A cycle is seven days from the cook's shopping day and can straddle a Sunday,
 * which is why the plan version it was built from cannot be its key: there may
 * be two of them. Those live in grocery_list_version, and they are what makes
 * staleness answerable. See docs/01-functional-spec.md section 8.1.
 */
export const groceryList = pgTable(
  "grocery_list",
  {
    id: primaryId(),
    userId: ownerId(),
    // The cycle covered. `ends_on` is derived, stored so a query can filter on
    // it without recomputing the cycle length in SQL. It is the last day
    // covered, inclusive; src/domain/shopping.ts compares against it by
    // calendar day for exactly that reason.
    //
    // Carried as `yyyy-mm-dd` strings rather than as Date: a `date` column has
    // no time and no zone, and node-pg would hand back a local midnight, so in
    // Paris `2026-08-31` arrives as 30 August in UTC and every cycle boundary
    // shifts by a day. src/domain/shopping.ts parses these explicitly.
    startsOn: date("starts_on", { mode: "string" }).notNull(),
    endsOn: date("ends_on", { mode: "string" }).notNull(),
    state: text("state").notNull().default("active"),
    // The property and the column now agree. It was `generatedAt` over a column
    // called `created_at`, so a service, a migration and a psql session each
    // had a different name for one value.
    //
    // "Generated" is the better name for the concept, since a list is produced
    // from a plan and regenerating it rewrites the lines of this same row, and
    // renaming the column would have been the nicer schema. It was the property
    // that moved, for the reason spelled out on `pantry_item.createdAt`:
    // drizzle-kit only resolves a column rename by asking interactively, and
    // hand-editing the snapshot it diffs against is how the next migration
    // silently generates wrong.
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // One live list per cycle. Regenerating rewrites the lines of this row
    // rather than writing a second one.
    uniqueIndex("grocery_list_one_live_per_cycle_idx")
      .on(t.userId, t.startsOn)
      .where(sql`state <> 'archived'`),
    index("grocery_list_user_idx").on(t.userId),
    // Reference target for grocery_line and grocery_list_version. See the note
    // on `recipe_ingredient` in ./recipes.ts.
    unique("grocery_list_id_user_key").on(t.id, t.userId),
    check(
      "grocery_list_state_known",
      sql`${t.state} in ${sql.raw(sqlInList(GROCERY_LIST_STATES))}`,
    ),
    ownerPolicy("grocery_list_owner", t.userId),
  ],
).enableRLS();

/**
 * Which plan versions a list was built from.
 *
 * At most two rows, because a seven-day cycle overlaps at most two ISO weeks,
 * and the set is rewritten on every regeneration. A single column on
 * grocery_list could not express a list that spans a Sunday, and without this
 * table "is my list stale" has no answer.
 */
export const groceryListVersion = pgTable(
  "grocery_list_version",
  {
    userId: ownerId(),
    groceryListId: uuid("grocery_list_id").notNull(),
    planVersionId: uuid("plan_version_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.groceryListId, t.planVersionId] }),
    // On `plan_version_id`, not `grocery_list_id`. The primary key above leads
    // with `grocery_list_id`, so an index on that column alone duplicated it
    // and served nothing: Postgres reads a leading key prefix from the primary
    // key's own index. `plan_version_id` is the column with no index at all,
    // and it is the one the queries use: "which lists were built from this
    // version", which is how staleness is answered, and the `on delete cascade`
    // that has to find these rows when a version is superseded.
    index("grocery_list_version_plan_version_idx").on(t.planVersionId),
    foreignKey({
      columns: [t.groceryListId, t.userId],
      foreignColumns: [groceryList.id, groceryList.userId],
      name: "grocery_list_version_list_user_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.planVersionId, t.userId],
      foreignColumns: [planVersion.id, planVersion.userId],
      name: "grocery_list_version_plan_version_user_fk",
    }).onDelete("cascade"),
    ownerPolicy("grocery_list_version_owner", t.userId),
  ],
).enableRLS();

/**
 * One shopping line.
 *
 * `source_entry_ids` is what makes a line explicable: dropping a line, the user
 * can be told which meals stop working. `unmergeable_group` holds together the
 * lines of one product whose units cannot be converted, so "2 oignons" and
 * "300 g d'oignons" sit under one heading instead of pretending to be a sum.
 *
 * `display_name` is the product to buy, not the vocabulary entry it resolved
 * to: a recipe asking for "coulis de tomate" shops for a coulis, and a line
 * reading "Tomate" sends the cook to the wrong shelf.
 */
export const groceryLine = pgTable(
  "grocery_line",
  {
    id: primaryId(),
    userId: ownerId(),
    groceryListId: uuid("grocery_list_id").notNull(),
    // Nullable, and single-column on purpose: see the note on
    // `recipe_ingredient.ingredient_id` in ./recipes.ts.
    ingredientId: uuid("ingredient_id").references(() => ingredient.id, {
      onDelete: "set null",
    }),
    displayName: text("display_name").notNull(),
    quantity: numeric("quantity", { precision: 12, scale: 3 }),
    unit: text("unit"),
    aisle: text("aisle"),
    origin: text("origin").notNull().default("derived"),
    sourceEntryIds: uuid("source_entry_ids")
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    // Written by the pantry subtraction in phase 7. Until then it stays false,
    // and the column exists so that phase is a service change, not a migration.
    coveredByPantry: boolean("covered_by_pantry").notNull().default(false),
    // Every recipe that asked for this line called the ingredient optional.
    // The line is shopped from its own section rather than hidden, which is
    // why the flag is stored rather than recomputed from the recipes.
    optional: boolean("optional").notNull().default(false),
    // The name written in the recipe is a narrower product than the ingredient
    // it links to: a coulis that resolved to Tomate. Stored because the pantry
    // is re-evaluated on every read, and having the ingredient is not having
    // this: tomatoes in the cupboard cover no coulis.
    productVariant: boolean("product_variant").notNull().default(false),
    checked: boolean("checked").notNull().default(false),
    unmergeableGroup: text("unmergeable_group"),
  },
  (t) => [
    index("grocery_line_list_idx").on(t.groceryListId, t.aisle, t.displayName),
    // The pantry subtraction matches lines against pantry items by ingredient,
    // and the `on delete set null` above scans this column whenever a
    // vocabulary entry is removed. Postgres does not index a foreign key column
    // for you.
    index("grocery_line_ingredient_idx").on(t.ingredientId),
    foreignKey({
      columns: [t.groceryListId, t.userId],
      foreignColumns: [groceryList.id, groceryList.userId],
      name: "grocery_line_list_user_fk",
    }).onDelete("cascade"),
    check(
      "grocery_line_origin_known",
      sql`${t.origin} in ${sql.raw(sqlInList(GROCERY_LINE_ORIGINS))}`,
    ),
    ownerPolicy("grocery_line_owner", t.userId),
  ],
).enableRLS();

export type GroceryList = typeof groceryList.$inferSelect;
export type GroceryListVersion = typeof groceryListVersion.$inferSelect;
export type NewGroceryList = typeof groceryList.$inferInsert;
export type GroceryLine = typeof groceryLine.$inferSelect;
export type NewGroceryLine = typeof groceryLine.$inferInsert;
