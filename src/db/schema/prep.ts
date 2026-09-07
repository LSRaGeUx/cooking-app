import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, ownerId, ownerPolicy, primaryId } from "./_shared";
import { planEntry } from "./plans";

/**
 * "Cook double Sunday, eat Tuesday in ten minutes."
 *
 * This is what turns the time budget data into something that pays off: a
 * Tuesday with a fifteen minute budget is satisfiable by Sunday's batch, and
 * nothing else in the model can express that.
 *
 * `source_entry_id` is nullable on purpose. Clearing the Sunday cooking session
 * must not delete Tuesday's meal, so the link survives with no source and the
 * plan shows it as unsourced. Silently deleting the dependent would lose a meal
 * the user still intends to eat.
 */
export const prepLink = pgTable(
  "prep_link",
  {
    id: primaryId(),
    userId: ownerId(),
    // Single-column on purpose. A composite key would have to be
    // `on delete set null` across both columns, and `user_id` is not null, so
    // clearing the Sunday session would fail instead of leaving the link
    // unsourced, which is the whole point of the column being nullable. See the
    // matching note on `recipe_ingredient.ingredient_id` in ./recipes.ts.
    sourceEntryId: uuid("source_entry_id").references(() => planEntry.id, {
      onDelete: "set null",
    }),
    dependentEntryId: uuid("dependent_entry_id").notNull(),
    servingsDrawn: smallint("servings_drawn").notNull().default(1),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [
    // A meal is served by one cooking session, not several. Two sources would
    // make the shortfall arithmetic ambiguous and the screen unreadable.
    uniqueIndex("prep_link_dependent_key").on(t.dependentEntryId),
    index("prep_link_source_idx").on(t.sourceEntryId),
    // Composite, so the denormalized `user_id` cannot disagree with the
    // dependent entry's. See the note on `recipe_ingredient` in ./recipes.ts.
    foreignKey({
      columns: [t.dependentEntryId, t.userId],
      foreignColumns: [planEntry.id, planEntry.userId],
      name: "prep_link_dependent_entry_user_fk",
    }).onDelete("cascade"),
    check("prep_link_servings_positive", sql`${t.servingsDrawn} > 0`),
    check(
      "prep_link_not_self",
      sql`${t.sourceEntryId} is null or ${t.sourceEntryId} <> ${t.dependentEntryId}`,
    ),
    ownerPolicy("prep_link_owner", t.userId),
  ],
).enableRLS();

export type PrepLink = typeof prepLink.$inferSelect;
export type NewPrepLink = typeof prepLink.$inferInsert;
