import { sql } from "drizzle-orm";
import { check, pgTable, smallint, text, unique, uuid } from "drizzle-orm/pg-core";
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
    mealTypeId: uuid("meal_type_id")
      .notNull()
      .references(() => mealType.id, { onDelete: "cascade" }),
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
