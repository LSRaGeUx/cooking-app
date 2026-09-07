import { agentActivity } from "@/db/schema";
import { withUser, type Tx } from "@/db/client";
import type { ActivityDirection, ActivityResult } from "@/domain/vocabulary";

/**
 * `direction` and `result` are typed from the vocabulary tuples rather than
 * spelled again as inline unions. Both columns now carry a check constraint
 * holding exactly those values, so a copy here would compile against a
 * vocabulary the database refuses, and the only symptom would be a hole in the
 * log: a row nothing wrote, discovered when a count came back short.
 *
 * `payloadSummary` matches the column's `$type<Record<string, unknown>>()`. It
 * used to be `unknown`, which accepted a string, a number or an array, none of
 * which the reader on the activity screen can render.
 */
export interface AgentActivityInput {
  userId: string;
  /** `null` when the caller holds no registered client, never `undefined`. */
  oauthClientId: string | null;
  toolName: string;
  direction: ActivityDirection;
  result: ActivityResult;
  rejectionCode?: string;
  payloadSummary?: Record<string, unknown>;
}

/**
 * Append-only. Every MCP call lands here, which is both a product feature (the
 * agent activity screen) and the audit trail that makes agent writes
 * attributable. Writes go through withUser so RLS applies to the log itself.
 */
export async function logAgentActivity(
  input: AgentActivityInput,
): Promise<void> {
  await withUser(input.userId, (tx) => logAgentActivityIn(tx, input));
}

/**
 * The same insert, on a transaction the caller already holds.
 *
 * This is what lets a write tool commit its row and its attribution together.
 * `logAgentActivity` opened its own transaction unconditionally, so an audit row
 * written from inside a tool's transaction actually landed in a second one: the
 * work could commit and the attribution roll back, or the reverse. A write with
 * no attribution is precisely what this table exists to make impossible.
 */
export async function logAgentActivityIn(
  tx: Tx,
  input: AgentActivityInput,
): Promise<void> {
  await tx.insert(agentActivity).values({
    userId: input.userId,
    oauthClientId: input.oauthClientId,
    toolName: input.toolName,
    direction: input.direction,
    result: input.result,
    rejectionCode: input.rejectionCode ?? null,
    payloadSummary: input.payloadSummary ?? null,
  });
}
