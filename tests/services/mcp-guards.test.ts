import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { db, withUser } from "@/db/client";
import { agentActivity } from "@/db/schema";
import { runTool } from "@/mcp/tool-runner";
import type { McpCallerContext } from "@/mcp/server";
import { ensureUserSetup } from "@/services/onboarding-service";
import {
  cleanupUser,
  clearAgentConsent,
  seedAgentConsent,
  testUser,
} from "../helpers";

/**
 * The guards every MCP call passes through.
 *
 * These are tested at the service level rather than over HTTP because they are
 * the controls that fail silently when they break: a rate limiter counting the
 * wrong rows still returns "allowed", and a revocation check reading the wrong
 * table still returns "authorized". Both of those happened while building this,
 * and both looked fine from the outside.
 */

const ctx = testUser();
const clientId = `test-client-${randomUUID()}`;

function caller(scopes: string[]): McpCallerContext {
  return { userId: ctx.userId, clientId, scopes: new Set(scopes) };
}

/**
 * `oauthConsent.userId` has a real foreign key to Better Auth's `user` table,
 * unlike the domain tables, so these tests need an actual account row rather
 * than the bare uuid the other service tests use. `seedAgentConsent` writes all
 * three rows, and the address it derives is the one the allowlist tests below
 * put on and take off the list.
 *
 * The three `insert` statements used to be written out here, in Better Auth's
 * own camelCase, so an upgrade that renamed a column would have broken every
 * test in this file with a "column does not exist" error and given no clue that
 * the fixture rather than the code was wrong. They now live in one place, for
 * exactly that day.
 */
const email = `${ctx.userId}@example.test`;

/** Idempotent, so a test that has just revoked can grant again. */
async function grantConsent(): Promise<void> {
  await seedAgentConsent(ctx, clientId, ["profile:read"]);
}

async function revokeConsent(): Promise<void> {
  await db.execute(
    sql`delete from "oauthConsent" where "clientId" = ${clientId}`,
  );
}

async function clearActivity(): Promise<void> {
  await withUser(ctx.userId, async (tx) => {
    await tx.execute(
      sql`delete from agent_activity where oauth_client_id = ${clientId}`,
    );
  });
}

beforeAll(async () => {
  await grantConsent();
  await ensureUserSetup(ctx);
});

afterAll(async () => {
  await cleanupUser(ctx);
  await clearAgentConsent(ctx, clientId);
});

describe("scope enforcement", () => {
  it("refuses a call beyond the granted scopes and names what is missing", async () => {
    await grantConsent();
    const result = await runTool(
      caller(["profile:read"]),
      {
        name: "test_tool",
        direction: "read",
        requiredScopes: ["recipes:write"],
      },
      async () => "should not run",
    );

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.error).toBe("MISSING_SCOPE");
    expect(payload.details.missing).toEqual(["recipes:write"]);
    // The error tells the agent how to fix it rather than only that it failed.
    expect(payload.message).toContain("reconnecter");
  });
});

describe("revocation", () => {
  /*
   * Both directions in one test, because the second half used to depend on the
   * first having run: "allows the call again once consent exists" granted
   * consent and asserted success, which is true whether or not anything had
   * ever been revoked, and under a `-t` filter or a reordering it proved
   * nothing at all. Revoke, refuse, re-grant, allow, in one place.
   */
  it("refuses a client whose consent is gone and allows it back once it returns", async () => {
    await grantConsent();
    await revokeConsent();

    const refused = await runTool(
      caller(["profile:read"]),
      {
        name: "test_tool",
        direction: "read",
        requiredScopes: ["profile:read"],
      },
      async () => "should not run",
    );

    expect(refused.isError).toBe(true);
    const payload = JSON.parse(refused.content[0]!.text);
    expect(payload.error).toBe("CLIENT_REVOKED");
    // The token is still cryptographically valid, so the refusal has to say
    // that reconnecting is the way back rather than leaving the agent to
    // conclude its credentials are broken.
    expect(payload.message).toContain("reconnecter");

    await grantConsent();

    const allowed = await runTool(
      caller(["profile:read"]),
      {
        name: "test_tool",
        direction: "read",
        requiredScopes: ["profile:read"],
      },
      async () => "ok",
    );

    expect(allowed.isError).toBeUndefined();
    expect(allowed.content[0]!.text).toBe("ok");
  });
});

describe("instance access", () => {
  // Set per test and put back, because every other test in this file relies on
  // the open list that tests/setup/instance-access.ts installs.
  afterEach(() => {
    process.env.ALLOWED_EMAILS = "";
  });

  it("refuses a token whose account is no longer on the allowlist", async () => {
    await grantConsent();
    process.env.ALLOWED_EMAILS = "someone.else@example.test";

    const result = await runTool(
      caller(["profile:read"]),
      {
        name: "test_tool",
        direction: "read",
        requiredScopes: ["profile:read"],
      },
      async () => "should not run",
    );

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.error).toBe("ACCESS_REVOKED");
    // The distinction that keeps an agent from looping through the OAuth dance:
    // this is not something reconnecting the client can fix.
    expect(payload.details.retryable).toBe(false);
    expect(payload.error).not.toBe("CLIENT_REVOKED");
  });

  it("refuses even while the consent row is perfectly valid", async () => {
    await grantConsent();
    process.env.ALLOWED_EMAILS = "someone.else@example.test";

    const rows = await db.execute(
      sql`select 1 from "oauthConsent" where "userId" = ${ctx.userId} and "clientId" = ${clientId} limit 1`,
    );
    expect(rows.rows.length).toBe(1);

    const result = await runTool(
      caller(["profile:read"]),
      {
        name: "test_tool",
        direction: "read",
        requiredScopes: ["profile:read"],
      },
      async () => "should not run",
    );

    expect(JSON.parse(result.content[0]!.text).error).toBe("ACCESS_REVOKED");
  });

  it("refuses a token whose account row is gone entirely", async () => {
    await grantConsent();
    const orphan = { ...caller(["profile:read"]), userId: randomUUID() };

    const result = await runTool(
      orphan,
      {
        name: "test_tool",
        direction: "read",
        requiredScopes: ["profile:read"],
      },
      async () => "should not run",
    );

    expect(JSON.parse(result.content[0]!.text).error).toBe("ACCESS_REVOKED");
  });

  it("allows the call again once the address is back on the list", async () => {
    await grantConsent();
    process.env.ALLOWED_EMAILS = `someone.else@example.test, ${email.toUpperCase()} `;

    const result = await runTool(
      caller(["profile:read"]),
      {
        name: "test_tool",
        direction: "read",
        requiredScopes: ["profile:read"],
      },
      async () => "ok",
    );

    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toBe("ok");
  });
});

describe("the audit log", () => {
  it("records every call, including the refused ones", async () => {
    await clearActivity();
    await grantConsent();

    await runTool(
      caller(["profile:read"]),
      {
        name: "logged_ok",
        direction: "read",
        requiredScopes: ["profile:read"],
      },
      async () => "ok",
    );
    await runTool(
      caller(["profile:read"]),
      {
        name: "logged_refused",
        direction: "read",
        requiredScopes: ["plan:write"],
      },
      async () => "unreachable",
    );

    const rows = await withUser(ctx.userId, (tx) =>
      tx.select().from(agentActivity),
    );
    const byTool = new Map(rows.map((row) => [row.toolName, row]));

    expect(byTool.get("logged_ok")).toMatchObject({
      result: "ok",
      oauthClientId: clientId,
    });
    expect(byTool.get("logged_refused")).toMatchObject({
      result: "rejected",
      rejectionCode: "MISSING_SCOPE",
    });
  });
});

describe("the rate limit", () => {
  /**
   * Fills the audit log with `count` calls attributed to `client`, which is
   * what the limiter counts.
   */
  async function flood(count: number, client = clientId): Promise<void> {
    if (count === 0) return;
    await withUser(ctx.userId, async (tx) => {
      await tx.insert(agentActivity).values(
        Array.from({ length: count }, () => ({
          userId: ctx.userId,
          oauthClientId: client,
          toolName: "flood",
          direction: "read",
          result: "ok",
        })),
      );
    });
  }

  interface Refusal {
    readonly error?: string;
    readonly message?: string;
    readonly details?: {
      readonly limitPerMinute?: number;
      readonly callsInLastMinute?: number;
    };
  }

  /**
   * One call, with the refusal parsed when there is one.
   *
   * A successful tool returns its own text, which here is the bare word "ok"
   * and not JSON, so the parse is conditional: parsing unconditionally turned a
   * pass into a `SyntaxError` about the letter o.
   */
  async function callOnce(): Promise<{ isError: boolean; payload: Refusal }> {
    const result = await runTool(
      caller(["profile:read"]),
      {
        name: "test_tool",
        direction: "read",
        requiredScopes: ["profile:read"],
      },
      async () => "ok",
    );
    const text = result.content[0]?.text ?? "";
    return {
      isError: result.isError === true,
      payload: result.isError === true ? (JSON.parse(text) as Refusal) : {},
    };
  }

  /**
   * The limit itself, read out of the refusal rather than copied from the
   * source.
   *
   * `RATE_LIMIT_CALLS_PER_MINUTE` is not exported, and the test used to write
   * `120` a second time, so the two could drift apart with nothing failing:
   * lower the constant and this test floods past the new limit and still
   * passes. The refusal carries `details.limitPerMinute`, which is the same
   * number the code decided with, so it is asked rather than assumed.
   */
  async function discoverLimit(): Promise<number> {
    await clearActivity();
    await flood(1000);
    const { isError, payload } = await callOnce();
    expect(isError).toBe(true);
    expect(payload.error).toBe("RATE_LIMITED");
    const limit = payload.details?.limitPerMinute;
    expect(typeof limit).toBe("number");
    await clearActivity();
    return limit as number;
  }

  it("refuses once the client has burned its budget for the minute", async () => {
    await clearActivity();
    await grantConsent();
    const limit = await discoverLimit();

    await flood(limit);
    const { isError, payload } = await callOnce();

    expect(isError).toBe(true);
    expect(payload.error).toBe("RATE_LIMITED");
    expect(payload.details?.callsInLastMinute).toBeGreaterThanOrEqual(limit);
    await clearActivity();
  });

  /**
   * The boundary, which is the half that was never checked. Only the refused
   * side was tested, so the limiter could have been off by one in either
   * direction: refusing at 119 costs a legitimate agent a call it was entitled
   * to, and allowing at 121 makes the published limit a lie.
   */
  it("allows the last call inside the budget and refuses the next one", async () => {
    await clearActivity();
    await grantConsent();
    const limit = await discoverLimit();

    await flood(limit - 1);
    const inside = await callOnce();
    expect(inside.isError, `call ${limit} of ${limit} was refused`).toBe(false);

    // That call logged itself, so the client is now exactly at the limit.
    const outside = await callOnce();
    expect(outside.isError, `call ${limit + 1} of ${limit} was allowed`).toBe(
      true,
    );
    expect(outside.payload.error).toBe("RATE_LIMITED");

    await clearActivity();
  });

  it("counts only this client's calls, not the whole account's", async () => {
    await clearActivity();
    await grantConsent();

    await withUser(ctx.userId, async (tx) => {
      await tx.insert(agentActivity).values(
        Array.from({ length: 150 }, () => ({
          userId: ctx.userId,
          oauthClientId: "some-other-client",
          toolName: "flood",
          direction: "read",
          result: "ok",
        })),
      );
    });

    const result = await runTool(
      caller(["profile:read"]),
      {
        name: "test_tool",
        direction: "read",
        requiredScopes: ["profile:read"],
      },
      async () => "ok",
    );

    expect(result.isError).toBeUndefined();
    await clearActivity();
    await withUser(ctx.userId, async (tx) => {
      await tx.execute(
        sql`delete from agent_activity where oauth_client_id = 'some-other-client'`,
      );
    });
  });
});
