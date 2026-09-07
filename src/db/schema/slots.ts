import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  smallint,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { SLOT_STATES, sqlInList } from "@/domain/vocabulary";
import { createdAt, ownerId, ownerPolicy, primaryId } from "./_shared";

export const mealType = pgTable(
  "meal_type",
  {
    id: primaryId(),
    userId: ownerId(),
    // `breakfast`, `lunch`, `dinner`, `snack`, or anything the user invents.
    key: text("key").notNull(),
    label: text("label").notNull(),
    sortOrder: smallint("sort_order").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    unique("meal_type_user_key_key").on(t.userId, t.key),
    // Reference target for slot_config and plan_entry. See the note on
    // `recipe_ingredient` in ./recipes.ts.
    unique("meal_type_id_user_key").on(t.id, t.userId),
    ownerPolicy("meal_type_owner", t.userId),
  ],
).enableRLS();

/**
 * A template, not a set of instances. One row per (day, meal) the user has an
 * opinion about. A plan version copies the grid it was made with into
 * plan_version.slot_snapshot, so changing this table never rewrites history.
 *
 * time_budget_min is the single most valuable organization field in the model:
 * it encodes "Tuesday I get home late" as a number an agent can plan against.
 */
export const slotConfig = pgTable(
  "slot_config",
  {
    id: primaryId(),
    userId: ownerId(),
    // ISO: 1 = Monday through 7 = Sunday.
    dayOfWeek: smallint("day_of_week").notNull(),
    mealTypeId: uuid("meal_type_id").notNull(),
    state: text("state").notNull().default("planned"),
    // Active cooking minutes the user is willing to spend at this slot.
    timeBudgetMin: smallint("time_budget_min"),
    defaultServings: smallint("default_servings"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("slot_config_user_day_meal_key").on(
      t.userId,
      t.dayOfWeek,
      t.mealTypeId,
    ),
    // The unique constraint above leads with `user_id`, so it cannot serve a
    // lookup by meal type alone, and that is what deleting a meal type has to
    // do to cascade. Postgres does not index a foreign key column for you.
    index("slot_config_meal_type_idx").on(t.mealTypeId),
    // Composite, for the reason spelled out on `recipe_ingredient`.
    foreignKey({
      columns: [t.mealTypeId, t.userId],
      foreignColumns: [mealType.id, mealType.userId],
      name: "slot_config_meal_type_user_fk",
    }).onDelete("cascade"),
    check("slot_config_day_range", sql`${t.dayOfWeek} between 1 and 7`),
    check(
      "slot_config_state_known",
      sql`${t.state} in ${sql.raw(sqlInList(SLOT_STATES))}`,
    ),
    ownerPolicy("slot_config_owner", t.userId),
  ],
).enableRLS();

export type MealType = typeof mealType.$inferSelect;
export type NewMealType = typeof mealType.$inferInsert;
export type SlotConfig = typeof slotConfig.$inferSelect;
export type NewSlotConfig = typeof slotConfig.$inferInsert;
