import { index, jsonb, pgTable, text } from "drizzle-orm/pg-core";
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
    payloadSummary: jsonb("payload_summary"),
    result: text("result").notNull(),
    rejectionCode: text("rejection_code"),
    createdAt: createdAt(),
  },
  (t) => [
    index("agent_activity_user_created_idx").on(t.userId, t.createdAt.desc()),
    ownerPolicy("agent_activity_owner", t.userId),
  ],
).enableRLS();

export type AgentActivity = typeof agentActivity.$inferSelect;
export type NewAgentActivity = typeof agentActivity.$inferInsert;
