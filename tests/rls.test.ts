import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db, withUser } from "@/db/client";
import { agentActivity } from "@/db/schema";

/**
 * The phase 0 exit criterion for tenancy: an unscoped query must return zero
 * rows rather than leak. This runs against the real Postgres from compose.yaml,
 * connected as the non-owner role, because RLS is exactly the kind of rule that
 * a mock would happily pretend to enforce.
 */
describe("row-level security on agent_activity", () => {
  const userA = randomUUID();
  const userB = randomUUID();

  afterAll(async () => {
    // Cleanup needs each owner's own scope, since RLS also applies to deletes.
    for (const userId of [userA, userB]) {
      await withUser(userId, async (tx) => {
        await tx.execute(
          sql`delete from ${agentActivity} where user_id = ${userId}`,
        );
      });
    }
  });

  it("stores a row for the scoped user", async () => {
    const rows = await withUser(userA, async (tx) =>
      tx
        .insert(agentActivity)
        .values({
          userId: userA,
          toolName: "whoami",
          direction: "read",
          result: "ok",
        })
        .returning(),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(userA);
  });

  it("hides another user's rows even from an explicit query", async () => {
    const seen = await withUser(userB, async (tx) =>
      tx.execute(
        sql`select id from ${agentActivity} where user_id = ${userA}`,
      ),
    );

    expect(seen.rows).toHaveLength(0);
  });

  it("returns zero rows when the scope is never set", async () => {
    // No withUser: app.user_id is unset, current_setting(..., true) is null, and
    // the policy predicate is therefore never true. Silent-but-empty, not a leak.
    const seen = await db.execute(sql`select id from ${agentActivity}`);

    expect(seen.rows).toHaveLength(0);
  });

  it("refuses to write a row owned by somebody else", async () => {
    // Drizzle wraps driver errors, so the RLS violation is on the cause. 42501 is
    // insufficient_privilege, which is what a failed WITH CHECK raises.
    const error = await withUser(userB, async (tx) =>
      tx.insert(agentActivity).values({
        userId: userA,
        toolName: "whoami",
        direction: "read",
        result: "ok",
      }),
    ).then(
      () => null,
      (e: unknown) => e as { cause?: { code?: string } },
    );

    expect(error).not.toBeNull();
    expect(error?.cause?.code).toBe("42501");
  });
});
