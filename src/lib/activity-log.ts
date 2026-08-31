import { agentActivity } from "@/db/schema";
import { withUser } from "@/db/client";

export interface AgentActivityInput {
  userId: string;
  oauthClientId: string | undefined;
  toolName: string;
  direction: "read" | "write";
  result: "ok" | "rejected" | "error";
  rejectionCode?: string;
  payloadSummary?: unknown;
}

/**
 * Append-only. Every MCP call lands here, which is both a product feature (the
 * agent activity screen) and the audit trail that makes agent writes
 * attributable. Writes go through withUser so RLS applies to the log itself.
 */
export async function logAgentActivity(
  input: AgentActivityInput,
): Promise<void> {
  await withUser(input.userId, async (tx) => {
    await tx.insert(agentActivity).values({
      userId: input.userId,
      oauthClientId: input.oauthClientId ?? null,
      toolName: input.toolName,
      direction: input.direction,
      result: input.result,
      rejectionCode: input.rejectionCode ?? null,
      payloadSummary: input.payloadSummary ?? null,
    });
  });
}
