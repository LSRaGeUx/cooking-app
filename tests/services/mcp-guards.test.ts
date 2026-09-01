import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, withUser } from "@/db/client";
import { agentActivity } from "@/db/schema";
import { runTool } from "@/mcp/tool-runner";
import type { McpCallerContext } from "@/mcp/server";
import { ensureUserSetup } from "@/services/onboarding-service";
import { cleanupUser, testUser } from "../helpers/fixtures";

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
 * unlike the domain tables, so this test has to create an actual account row
 * rather than the bare uuid the other service tests use.
 */
async function createAuthUser(): Promise<void> {
  await db.execute(sql`
    insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
    values (${ctx.userId}, 'Test', ${`${ctx.userId}@example.test`}, false, now(), now())
    on conflict do nothing
  `);
}

async function grantConsent(): Promise<void> {
  await db.execute(sql`
    insert into "oauthClient" (id, "clientId", name, "redirectUris", "createdAt", "updatedAt")
    values (${randomUUID()}, ${clientId}, 'Client de test', ${JSON.stringify(["http://localhost:9999/callback"])}::jsonb, now(), now())
    on conflict do nothing
  `);
  await db.execute(sql`
    insert into "oauthConsent" (id, "clientId", "userId", scopes, "createdAt", "updatedAt")
    values (${randomUUID()}, ${clientId}, ${ctx.userId}, ${JSON.stringify(["profile:read"])}::jsonb, now(), now())
    on conflict do nothing
  `);
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
  await createAuthUser();
  await ensureUserSetup(ctx);
});

afterAll(async () => {
  await db.execute(
    sql`delete from "oauthConsent" where "clientId" = ${clientId}`,
  );
  await db.execute(sql`delete from "oauthClient" where "clientId" = ${clientId}`);
  await cleanupUser(ctx);
  await db.execute(sql`delete from "user" where id = ${ctx.userId}`);
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
  it("refuses a client whose consent is gone, even with a valid token", async () => {
    await revokeConsent();

    const result = await runTool(
      caller(["profile:read"]),
      { name: "test_tool", direction: "read", requiredScopes: ["profile:read"] },
      async () => "should not run",
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text).error).toBe("CLIENT_REVOKED");
  });

  it("allows the call again once consent exists", async () => {
    await grantConsent();

    const result = await runTool(
      caller(["profile:read"]),
      { name: "test_tool", direction: "read", requiredScopes: ["profile:read"] },
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
      { name: "logged_ok", direction: "read", requiredScopes: ["profile:read"] },
      async () => "ok",
    );
    await runTool(
      caller(["profile:read"]),
      { name: "logged_refused", direction: "read", requiredScopes: ["plan:write"] },
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
  it("refuses once the client has burned its budget for the minute", async () => {
    await clearActivity();
    await grantConsent();

    // Straight into the audit log, because that is what the limiter counts.
    await withUser(ctx.userId, async (tx) => {
      await tx.insert(agentActivity).values(
        Array.from({ length: 120 }, () => ({
          userId: ctx.userId,
          oauthClientId: clientId,
          toolName: "flood",
          direction: "read",
          result: "ok",
        })),
      );
    });

    const result = await runTool(
      caller(["profile:read"]),
      { name: "test_tool", direction: "read", requiredScopes: ["profile:read"] },
      async () => "should not run",
    );

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.error).toBe("RATE_LIMITED");
    expect(payload.details.callsInLastMinute).toBeGreaterThanOrEqual(120);
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
      { name: "test_tool", direction: "read", requiredScopes: ["profile:read"] },
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
