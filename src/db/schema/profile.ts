import { sql } from "drizzle-orm";
import {
  char,
  check,
  numeric,
  pgTable,
  smallint,
  text,
  unique,
} from "drizzle-orm/pg-core";
import {
  AGENT_AUTHORITIES,
  ALLERGEN_SEVERITIES,
  DIETS,
  sqlInList,
} from "@/domain/vocabulary";
import {
  createdAt,
  ownerId,
  ownerPolicy,
  primaryId,
  updatedAt,
} from "./_shared";

/**
 * One row per user, created on demand by the profile service. The columns here
 * are the enforced part of what we know about the cook; the open part is the
 * fact store, which lands in phase 3.
 *
 * Enum-like columns are text plus a check constraint rather than a Postgres
 * enum: the vocabularies here are expected to grow, and adding a value to an
 * enum type is a migration that cannot run inside a transaction.
 */
export const profile = pgTable(
  "profile",
  {
    userId: ownerId().primaryKey(),
    diet: text("diet").notNull().default("none"),
    dietNotes: text("diet_notes"),
    skillLevel: smallint("skill_level").notNull().default(3),
    defaultServings: smallint("default_servings").notNull().default(2),
    defaultTimeBudgetMin: smallint("default_time_budget_min"),
    varietyPreference: smallint("variety_preference").notNull().default(3),
    // ISO weekday of the weekly shop, 1 to 7. Null means the cook has not said,
    // and grocery lists then fall back to Monday-to-Sunday weeks. See
    // src/domain/shopping.ts.
    shoppingDay: smallint("shopping_day"),
    weeklyBudgetAmount: numeric("weekly_budget_amount", {
      precision: 10,
      scale: 2,
    }),
    weeklyBudgetCurrency: char("weekly_budget_currency", { length: 3 }),
    agentAuthority: text("agent_authority").notNull().default("proposal"),
    // Used by write validation: an entry may exceed its slot budget by this
    // much before the write is rejected rather than merely warned about.
    timeBudgetToleranceMin: smallint("time_budget_tolerance_min")
      .notNull()
      .default(10),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("profile_diet_known", sql`${t.diet} in ${sql.raw(sqlInList(DIETS))}`),
    check("profile_skill_range", sql`${t.skillLevel} between 1 and 5`),
    check("profile_variety_range", sql`${t.varietyPreference} between 1 and 5`),
    check(
      "profile_shopping_day_range",
      sql`${t.shoppingDay} is null or ${t.shoppingDay} between 1 and 7`,
    ),
    check("profile_servings_positive", sql`${t.defaultServings} > 0`),
    check(
      "profile_authority_known",
      sql`${t.agentAuthority} in ${sql.raw(sqlInList(AGENT_AUTHORITIES))}`,
    ),
    ownerPolicy("profile_owner", t.userId),
  ],
).enableRLS();

/**
 * The only hard block in the system. `matches` is explicit rather than
 * inferred, because a false negative here is a health event: the user lists
 * every name and alias that should trigger the block, and the matcher in
 * src/domain/allergens.ts never guesses beyond that list.
 */
export const allergen = pgTable(
  "allergen",
  {
    id: primaryId(),
    userId: ownerId(),
    name: text("name").notNull(),
    severity: text("severity").notNull(),
    matches: text("matches")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdAt: createdAt(),
  },
  (t) => [
    unique("allergen_user_name_key").on(t.userId, t.name),
    check(
      "allergen_severity_known",
      sql`${t.severity} in ${sql.raw(sqlInList(ALLERGEN_SEVERITIES))}`,
    ),
    ownerPolicy("allergen_owner", t.userId),
  ],
).enableRLS();

/**
 * Ingredients the user refuses. Same shape as an allergen minus severity,
 * because an exclusion only ever produces a warning.
 */
export const exclusion = pgTable(
  "exclusion",
  {
    id: primaryId(),
    userId: ownerId(),
    name: text("name").notNull(),
    matches: text("matches")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdAt: createdAt(),
  },
  (t) => [
    unique("exclusion_user_name_key").on(t.userId, t.name),
    ownerPolicy("exclusion_owner", t.userId),
  ],
).enableRLS();

/**
 * `key` is a controlled vocabulary so a recipe can declare requirements that
 * are comparable across users; `label` carries the display name for anything
 * the user added themselves.
 */
export const equipment = pgTable(
  "equipment",
  {
    id: primaryId(),
    userId: ownerId(),
    key: text("key").notNull(),
    label: text("label"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("equipment_user_key_key").on(t.userId, t.key),
    ownerPolicy("equipment_owner", t.userId),
  ],
).enableRLS();

export type Profile = typeof profile.$inferSelect;
export type NewProfile = typeof profile.$inferInsert;
export type Allergen = typeof allergen.$inferSelect;
export type Exclusion = typeof exclusion.$inferSelect;
export type Equipment = typeof equipment.$inferSelect;
