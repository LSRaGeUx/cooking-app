import { desc, eq, sql } from "drizzle-orm";
import { agentActivity } from "@/db/schema";
import { inScope, type ServiceContext } from "./context";

/**
 * The agent activity log, read path.
 *
 * This is a product feature rather than telemetry: it is where a user finds out
 * what their agent actually did, and it is the first place to look when a
 * proposal was bad. Append-only, and nothing in the app offers a way to edit or
 * delete an entry.
 */

export interface ActivityEntry {
  readonly id: string;
  readonly toolName: string;
  readonly direction: string;
  readonly result: string;
  readonly rejectionCode: string | null;
  readonly oauthClientId: string | null;
  readonly payloadSummary: unknown;
  readonly createdAt: Date;
}

export interface ActivityPage {
  readonly entries: ActivityEntry[];
  readonly total: number;
}

export async function listAgentActivity(
  ctx: ServiceContext,
  options: { limit?: number; offset?: number } = {},
): Promise<ActivityPage> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);

  return inScope(ctx, async (tx) => {
    const entries = await tx
      .select()
      .from(agentActivity)
      .where(eq(agentActivity.userId, ctx.userId))
      .orderBy(desc(agentActivity.createdAt))
      .limit(limit)
      .offset(offset);

    const counted = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(agentActivity)
      .where(eq(agentActivity.userId, ctx.userId));

    return {
      entries: entries.map((row) => ({
        id: row.id,
        toolName: row.toolName,
        direction: row.direction,
        result: row.result,
        rejectionCode: row.rejectionCode,
        oauthClientId: row.oauthClientId,
        payloadSummary: row.payloadSummary,
        createdAt: row.createdAt,
      })),
      total: counted[0]?.total ?? 0,
    };
  });
}

/** Whether any agent has ever called this account, for the connection test. */
export async function lastAgentCall(
  ctx: ServiceContext,
): Promise<Date | null> {
  return inScope(ctx, async (tx) => {
    const rows = await tx
      .select({ createdAt: agentActivity.createdAt })
      .from(agentActivity)
      .where(eq(agentActivity.userId, ctx.userId))
      .orderBy(desc(agentActivity.createdAt))
      .limit(1);
    return rows[0]?.createdAt ?? null;
  });
}
