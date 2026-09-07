import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  pgTable,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  FEEDBACK_OUTCOMES,
  PORTION_ISSUES,
  sqlInList,
} from "@/domain/vocabulary";
import { createdAt, ownerId, ownerPolicy, primaryId } from "./_shared";
import { planEntry } from "./plans";

/**
 * What actually happened, per planned meal. This is the table that makes week
 * 20 better than week 1.
 *
 * It hangs off `plan_entry`, which is a row in an immutable version, so an edit
 * to the week would normally orphan it. The planning service re-points existing
 * feedback at the new entry when it copies a slot forward, because feedback
 * belongs to "what happened in that slot this week", not to one revision of the
 * plan. See the note in docs/02-data-model.md section 6.
 *
 * Everything except the outcome is optional on purpose. A prompt that demands a
 * rating and a note is a prompt people stop answering, and an outcome alone is
 * already the strongest signal here.
 */
export const entryFeedback = pgTable(
  "entry_feedback",
  {
    id: primaryId(),
    userId: ownerId(),
    planEntryId: uuid("plan_entry_id").notNull(),
    outcome: text("outcome").notNull(),
    /** What was eaten instead. Often more useful than a rating. */
    swappedFor: text("swapped_for"),
    rating: smallint("rating"),
    note: text("note"),
    /** Drives the slot time budget suggestion. */
    tookLonger: boolean("took_longer").notNull().default(false),
    portionIssue: text("portion_issue"),
    createdAt: createdAt(),
  },
  (t) => [
    // One verdict per meal. Recording again updates rather than appends.
    uniqueIndex("entry_feedback_entry_key").on(t.planEntryId),
    index("entry_feedback_user_idx").on(t.userId, t.createdAt.desc()),
    // Composite, so the denormalized `user_id` cannot disagree with the
    // parent's. See the note on `recipe_ingredient` in ./recipes.ts.
    foreignKey({
      columns: [t.planEntryId, t.userId],
      foreignColumns: [planEntry.id, planEntry.userId],
      name: "entry_feedback_plan_entry_user_fk",
    }).onDelete("cascade"),
    check(
      "entry_feedback_outcome_known",
      sql`${t.outcome} in ${sql.raw(sqlInList(FEEDBACK_OUTCOMES))}`,
    ),
    check(
      "entry_feedback_portion_known",
      sql`${t.portionIssue} is null or ${t.portionIssue} in ${sql.raw(sqlInList(PORTION_ISSUES))}`,
    ),
    check(
      "entry_feedback_rating_range",
      sql`${t.rating} is null or ${t.rating} between 1 and 5`,
    ),
    ownerPolicy("entry_feedback_owner", t.userId),
  ],
).enableRLS();

export type EntryFeedback = typeof entryFeedback.$inferSelect;
export type NewEntryFeedback = typeof entryFeedback.$inferInsert;
