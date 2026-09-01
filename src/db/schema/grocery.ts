import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  numeric,
  pgTable,
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
 * `plan_version_id` records which version the list was last generated from, and
 * it moves forward on regeneration: the list belongs to a week, while a version
 * is superseded by every edit. Finding "this week's list" therefore joins
 * through plan_version to plan rather than storing a second key.
 */
export const groceryList = pgTable(
  "grocery_list",
  {
    id: primaryId(),
    userId: ownerId(),
    planVersionId: uuid("plan_version_id")
      .notNull()
      .references(() => planVersion.id, { onDelete: "cascade" }),
    state: text("state").notNull().default("active"),
    generatedAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // One live list per version. The service keeps it to one per week by moving
    // plan_version_id forward instead of writing a second row.
    uniqueIndex("grocery_list_one_live_per_version_idx")
      .on(t.planVersionId)
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
export type NewGroceryList = typeof groceryList.$inferInsert;
export type GroceryLine = typeof groceryLine.$inferSelect;
export type NewGroceryLine = typeof groceryLine.$inferInsert;
