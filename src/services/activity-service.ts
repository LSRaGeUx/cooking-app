import { desc, eq, sql } from "drizzle-orm";
import { agentActivity } from "@/db/schema";
import { activityQuerySchema } from "@/domain/schemas";
import type { ActivityDirection, ActivityResult } from "@/domain/vocabulary";
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
  /**
   * The vocabulary unions rather than `string`. Both columns now carry a check
   * constraint holding exactly these values, so a widened type here would
   * promise a reader something the database refuses to store.
   */
  readonly direction: ActivityDirection;
  readonly result: ActivityResult;
  readonly rejectionCode: string | null;
  readonly oauthClientId: string | null;
  readonly payloadSummary: Record<string, unknown> | null;
  readonly createdAt: Date;
}

export interface ActivityPage {
  readonly entries: ActivityEntry[];
  readonly total: number;
}

/**
 * Paging comes from `activityQuerySchema` rather than from a pair of
 * hand-written clamps. The clamps allowed a limit of 200 where the published
 * schema says 100, so the same call answered differently through the two entry
 * points, which is the exact drift rule 9 exists to stop.
 */
export async function listAgentActivity(
  ctx: ServiceContext,
  options: unknown = {},
): Promise<ActivityPage> {
  const { limit, offset } = activityQuerySchema.parse(options);

  return inScope(ctx, async ({ tx }) => {
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
        // The column is `text` plus a check constraint, so Drizzle types it as
        // `string`. Narrowed here, at the one boundary that turns a row into a
        // view, rather than at every reader.
        direction: row.direction as ActivityDirection,
        result: row.result as ActivityResult,
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
export async function lastAgentCall(ctx: ServiceContext): Promise<Date | null> {
  return inScope(ctx, async ({ tx }) => {
    const rows = await tx
      .select({ createdAt: agentActivity.createdAt })
      .from(agentActivity)
      .where(eq(agentActivity.userId, ctx.userId))
      .orderBy(desc(agentActivity.createdAt))
      .limit(1);
    return rows[0]?.createdAt ?? null;
  });
}
