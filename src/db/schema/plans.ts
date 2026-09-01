import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  PLAN_AUTHORS,
  PLAN_VERSION_STATES,
  sqlInList,
} from "@/domain/vocabulary";
import { createdAt, ownerId, ownerPolicy, primaryId } from "./_shared";
import { mealType } from "./slots";
import { recipe } from "./recipes";

/**
 * One plan per user per ISO week. Never a bare week number: a plan that spans a
 * year boundary is still unambiguous because the year is stored with it.
 */
export const plan = pgTable(
  "plan",
  {
    id: primaryId(),
    userId: ownerId(),
    isoYear: smallint("iso_year").notNull(),
    isoWeek: smallint("iso_week").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("plan_user_week_key").on(t.userId, t.isoYear, t.isoWeek),
    check("plan_week_range", sql`${t.isoWeek} between 1 and 53`),
    ownerPolicy("plan_owner", t.userId),
  ],
).enableRLS();

/**
 * Immutable once created, except for the state transition columns. Every edit
 * creates a new version, which is what makes an agent action revertible and a
 * proposal diffable. The two partial unique indexes enforce the invariants at
 * the database level rather than trusting the service to be careful:
 * at most one active and at most one pending version per plan.
 */
export const planVersion = pgTable(
  "plan_version",
  {
    id: primaryId(),
    userId: ownerId(),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plan.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    state: text("state").notNull().default("pending"),
    createdBy: text("created_by").notNull().default("user"),
    createdByClientId: text("created_by_client_id"),
    // The agent's one-paragraph explanation of the week.
    summary: text("summary"),
    // The grid as configured when this version was created, so later slot
    // config changes never rewrite history.
    slotSnapshot: jsonb("slot_snapshot").notNull(),
    // Captured on reject. High-value signal, and offered back to the agent.
    rejectionReason: text("rejection_reason"),
    createdAt: createdAt(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
  },
  (t) => [
    unique("plan_version_plan_number_key").on(t.planId, t.versionNumber),
    uniqueIndex("plan_version_one_active_idx")
      .on(t.planId)
      .where(sql`state = 'active'`),
    uniqueIndex("plan_version_one_pending_idx")
      .on(t.planId)
      .where(sql`state = 'pending'`),
    index("plan_version_plan_idx").on(t.planId, t.versionNumber.desc()),
    check(
      "plan_version_state_known",
      sql`${t.state} in ${sql.raw(sqlInList(PLAN_VERSION_STATES))}`,
    ),
    check(
      "plan_version_author_known",
      sql`${t.createdBy} in ${sql.raw(sqlInList(PLAN_AUTHORS))}`,
    ),
    ownerPolicy("plan_version_owner", t.userId),
  ],
).enableRLS();

/**
 * One recipe assigned to one slot inside one version.
 *
 * The title and revision snapshots keep history readable after a recipe is
 * soft-deleted or edited. The rationale pair is what makes personalization
 * inspectable: it is nullable for user-created entries and required for
 * agent-created ones, which the service enforces rather than the schema,
 * because the constraint depends on the parent version's author.
 */
export const planEntry = pgTable(
  "plan_entry",
  {
    id: primaryId(),
    userId: ownerId(),
    planVersionId: uuid("plan_version_id")
      .notNull()
      .references(() => planVersion.id, { onDelete: "cascade" }),
    dayOfWeek: smallint("day_of_week").notNull(),
    mealTypeId: uuid("meal_type_id")
      .notNull()
      .references(() => mealType.id, { onDelete: "restrict" }),
    recipeId: uuid("recipe_id").references(() => recipe.id, {
      onDelete: "set null",
    }),
    recipeTitleSnapshot: text("recipe_title_snapshot").notNull(),
    recipeRevisionSnapshot: integer("recipe_revision_snapshot"),
    servings: smallint("servings").notNull(),
    note: text("note"),
    rationale: text("rationale"),
    // Fact ids, feedback ids and pantry item ids the agent cited.
    rationaleRefs: jsonb("rationale_refs"),
    // For several dishes in one slot.
    position: smallint("position").notNull().default(0),
  },
  (t) => [
    index("plan_entry_version_idx").on(t.planVersionId, t.dayOfWeek),
    check("plan_entry_day_range", sql`${t.dayOfWeek} between 1 and 7`),
    check("plan_entry_servings_positive", sql`${t.servings} > 0`),
    ownerPolicy("plan_entry_owner", t.userId),
  ],
).enableRLS();

export type Plan = typeof plan.$inferSelect;
export type NewPlan = typeof plan.$inferInsert;
export type PlanVersion = typeof planVersion.$inferSelect;
export type NewPlanVersion = typeof planVersion.$inferInsert;
export type PlanEntry = typeof planEntry.$inferSelect;
export type NewPlanEntry = typeof planEntry.$inferInsert;
