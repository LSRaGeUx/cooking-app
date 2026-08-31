import { sql } from "drizzle-orm";
import {
  index,
  jsonb,
  pgPolicy,
  pgRole,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * The least-privileged runtime role. Created by src/db/bootstrap.sql, so it is
 * declared as existing here rather than managed by drizzle-kit.
 */
export const appRole = pgRole("cooking_app").existing();

/**
 * Every user-owned row is scoped by this session variable, set per transaction
 * by withUser() in src/db/client.ts. `true` as the second argument to
 * current_setting means "return null instead of erroring when unset", which is
 * what makes an unscoped query return zero rows instead of blowing up.
 */
const currentUserId = sql`nullif(current_setting('app.user_id', true), '')::uuid`;

/**
 * Append-only audit log of every MCP call. Specified in docs/02-data-model.md.
 * It is the first user-owned table on purpose: the phase 0 MCP spike needs it,
 * and it gives RLS something real to protect.
 */
export const agentActivity = pgTable(
  "agent_activity",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull(),
    oauthClientId: text("oauth_client_id"),
    toolName: text("tool_name").notNull(),
    direction: text("direction").notNull(),
    payloadSummary: jsonb("payload_summary"),
    result: text("result").notNull(),
    rejectionCode: text("rejection_code"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("agent_activity_user_created_idx").on(t.userId, t.createdAt.desc()),
    pgPolicy("agent_activity_owner", {
      for: "all",
      to: appRole,
      using: sql`${t.userId} = ${currentUserId}`,
      withCheck: sql`${t.userId} = ${currentUserId}`,
    }),
  ],
).enableRLS();

export type AgentActivity = typeof agentActivity.$inferSelect;
export type NewAgentActivity = typeof agentActivity.$inferInsert;
