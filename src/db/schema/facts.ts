import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import {
  FACT_CATEGORIES,
  FACT_CONFIDENCES,
  FACT_POLARITIES,
  FACT_SOURCES,
  FACT_STATEMENT_MAX_LENGTH,
  FACT_STATUSES,
  sqlInList,
} from "@/domain/vocabulary";
import { createdAt, ownerId, ownerPolicy, primaryId } from "./_shared";

/**
 * The learning store, and the part of this product that is actually hard to
 * copy. Everything about this table is shaped by one decision: a fact is never
 * rewritten to mean something else.
 *
 * Contradiction is resolved by retiring the old row and inserting a new one
 * that points at it through `supersedes_id`, because "used to hate mushrooms,
 * now eats them" is real signal and an in-place update destroys it.
 *
 * The statement length cap is not cosmetic either. Without it the field decays
 * into the free-text blob the spec explicitly rejected, and atomic facts are
 * what make the store prunable, diffable and attributable.
 */
export const fact = pgTable(
  "fact",
  {
    id: primaryId(),
    userId: ownerId(),
    category: text("category").notNull().default("other"),
    statement: text("statement").notNull(),
    polarity: text("polarity").notNull().default("neutral"),
    confidence: text("confidence").notNull().default("medium"),
    source: text("source").notNull().default("user"),
    // Which agent wrote it. Matches oauthClient.id, which Better Auth types as
    // text, so no foreign key.
    sourceClientId: text("source_client_id"),
    status: text("status").notNull().default("unconfirmed"),
    supersedesId: uuid("supersedes_id").references(
      (): AnyPgColumn => fact.id,
      { onDelete: "set null" },
    ),
    // Entry ids, feedback ids, or free text backing the claim.
    evidence: jsonb("evidence"),
    createdAt: createdAt(),
    // Bumped when the fact is included in a profile snapshot, which is what
    // makes the pruning heuristic work.
    lastReferencedAt: timestamp("last_referenced_at", { withTimezone: true }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
  },
  (t) => [
    index("fact_user_status_idx").on(t.userId, t.status),
    index("fact_user_referenced_idx").on(t.userId, t.lastReferencedAt),
    check(
      "fact_category_known",
      sql`${t.category} in ${sql.raw(sqlInList(FACT_CATEGORIES))}`,
    ),
    check(
      "fact_polarity_known",
      sql`${t.polarity} in ${sql.raw(sqlInList(FACT_POLARITIES))}`,
    ),
    check(
      "fact_confidence_known",
      sql`${t.confidence} in ${sql.raw(sqlInList(FACT_CONFIDENCES))}`,
    ),
    check(
      "fact_source_known",
      sql`${t.source} in ${sql.raw(sqlInList(FACT_SOURCES))}`,
    ),
    check(
      "fact_status_known",
      sql`${t.status} in ${sql.raw(sqlInList(FACT_STATUSES))}`,
    ),
    check(
      "fact_statement_length",
      sql`char_length(${t.statement}) between 1 and ${sql.raw(String(FACT_STATEMENT_MAX_LENGTH))}`,
    ),
    // A retired fact must carry its retirement date, and a live one must not.
    check(
      "fact_retired_at_matches_status",
      sql`(${t.status} = 'retired') = (${t.retiredAt} is not null)`,
    ),
    ownerPolicy("fact_owner", t.userId),
  ],
).enableRLS();

export type Fact = typeof fact.$inferSelect;
export type NewFact = typeof fact.$inferInsert;
