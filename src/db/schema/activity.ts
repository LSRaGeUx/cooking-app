import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text } from "drizzle-orm/pg-core";
import {
  ACTIVITY_DIRECTIONS,
  ACTIVITY_RESULTS,
  sqlInList,
} from "@/domain/vocabulary";
import { createdAt, ownerId, ownerPolicy, primaryId } from "./_shared";

/**
 * Append-only audit log of every MCP call. Specified in docs/02-data-model.md.
 * Retention is 90 days by default; the purge job lands with the soft-delete
 * purge in phase 10.
 */
export const agentActivity = pgTable(
  "agent_activity",
  {
    id: primaryId(),
    userId: ownerId(),
    oauthClientId: text("oauth_client_id"),
    toolName: text("tool_name").notNull(),
    direction: text("direction").notNull(),
    // The tool's arguments, reduced to something safe to keep: counts, ids and
    // enum values, never a whole recipe. Typed rather than `unknown`, so a
    // reader does not cast at every call site.
    payloadSummary: jsonb("payload_summary").$type<Record<string, unknown>>(),
    result: text("result").notNull(),
    rejectionCode: text("rejection_code"),
    createdAt: createdAt(),
  },
  (t) => [
    index("agent_activity_user_created_idx").on(t.userId, t.createdAt.desc()),
    // `direction` and `result` are enum-like and were free text with no
    // constraint, unlike every other column of this shape in the schema. A typo
    // in a service was therefore storable, and the only symptom was a hole in
    // the log: a row filtered out of every count that reads these columns, with
    // nothing to say it had been written wrong.
    check(
      "agent_activity_direction_known",
      sql`${t.direction} in ${sql.raw(sqlInList(ACTIVITY_DIRECTIONS))}`,
    ),
    check(
      "agent_activity_result_known",
      sql`${t.result} in ${sql.raw(sqlInList(ACTIVITY_RESULTS))}`,
    ),
    ownerPolicy("agent_activity_owner", t.userId),
  ],
).enableRLS();

export type AgentActivity = typeof agentActivity.$inferSelect;
export type NewAgentActivity = typeof agentActivity.$inferInsert;
