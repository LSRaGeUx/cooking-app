import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  GROCERY_LINE_ORIGINS,
  GROCERY_LIST_STATES,
  sqlInList,
} from "@/domain/vocabulary";
import { createdAt, ownerId, ownerPolicy, primaryId } from "./_shared";
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
    // it without recomputing the cycle length in SQL.
    // The cycle covered. `ends_on` is derived, stored so a query can filter on
    // it without recomputing the cycle length in SQL.
    //
    // Carried as `yyyy-mm-dd` strings rather than as Date: a `date` column has
    // no time and no zone, and node-pg would hand back a local midnight, so in
    // Paris `2026-08-31` arrives as 30 August in UTC and every cycle boundary
    // shifts by a day. src/domain/shopping.ts parses these explicitly.
    startsOn: date("starts_on", { mode: "string" }).notNull(),
    endsOn: date("ends_on", { mode: "string" }).notNull(),
    state: text("state").notNull().default("active"),
    generatedAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // One live list per cycle. Regenerating rewrites the lines of this row
    // rather than writing a second one.
    uniqueIndex("grocery_list_one_live_per_cycle_idx")
      .on(t.userId, t.startsOn)
      .where(sql`state <> 'archived'`),
    index("grocery_list_user_idx").on(t.userId),
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
    groceryListId: uuid("grocery_list_id")
      .notNull()
      .references(() => groceryList.id, { onDelete: "cascade" }),
    planVersionId: uuid("plan_version_id")
      .notNull()
      .references(() => planVersion.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.groceryListId, t.planVersionId] }),
    index("grocery_list_version_list_idx").on(t.groceryListId),
    ownerPolicy("grocery_list_version_owner", t.userId),
  ],
).enableRLS();

/**
 * One shopping line.
 *
 * `source_entry_ids` is what makes a line explicable: dropping a line, the user
 * can be told which meals stop working. `unmergeable_group` holds together the
 * lines of one ingredient whose units cannot be converted, so "2 oignons" and
 * "300 g d'oignons" sit under one heading instead of pretending to be a sum.
 */
export const groceryLine = pgTable(
  "grocery_line",
  {
    id: primaryId(),
    userId: ownerId(),
    groceryListId: uuid("grocery_list_id")
      .notNull()
      .references(() => groceryList.id, { onDelete: "cascade" }),
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
    checked: boolean("checked").notNull().default(false),
    unmergeableGroup: text("unmergeable_group"),
  },
  (t) => [
    index("grocery_line_list_idx").on(t.groceryListId, t.aisle, t.displayName),
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
