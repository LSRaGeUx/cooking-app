import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { db } from "@/db/client";
import { MCP_SCOPES } from "@/lib/scopes";
import { buildServer, type McpCallerContext } from "@/mcp/server";
import {
  listConnectedClients,
  revokeClient,
} from "@/services/agent-client-service";
import {
  cleanupUser,
  clearAgentConsent,
  expectDomainError,
  seedAgentConsent,
  setupTestUser,
} from "../helpers";

/**
 * Connected agent clients, and revoking one.
 *
 * Revocation is a security control with no test at all until now, and the way it
 * fails is quiet. Both functions issue raw SQL against Better Auth's own tables,
 * in Better Auth's own camelCase, and those tables are outside the Drizzle schema
 * and outside row-level security. So there is no second line of defence on any
 * of these rows: every statement scopes by `userId` in the statement itself, and
 * a library upgrade that renames a column breaks the revoke without breaking
 * anything that would be noticed.
 *
 * The three things a revoke has to do are asserted separately, because doing two
 * of them is the state the audit found: the consent row goes, the stored access
 * and refresh tokens go, and every subsequent MCP call is refused. The last one
 * is what closes the window on a token already in an agent's hands, since an
 * access token here is a JWT verified against our own JWKS and stays
 * cryptographically valid until it expires.
 */

let user: Awaited<ReturnType<typeof setupTestUser>>;
let other: Awaited<ReturnType<typeof setupTestUser>>;

const clientA = `agent-clients-a-${randomUUID()}`;
const clientB = `agent-clients-b-${randomUUID()}`;
const clientOther = `agent-clients-other-${randomUUID()}`;

/** A stored token pair, the way the authorization server writes one. */
async function issueTokens(userId: string, clientId: string): Promise<void> {
  await db.execute(sql`
    insert into "oauthAccessToken"
      (id, token, "clientId", "userId", scopes, "expiresAt", "createdAt")
    values (
      ${randomUUID()}, ${`access-${randomUUID()}`}, ${clientId}, ${userId},
      ${JSON.stringify(["cooking:read"])}::jsonb, now() + interval '1 hour', now()
    )
  `);
  await db.execute(sql`
    insert into "oauthRefreshToken"
      (id, token, "clientId", "userId", scopes, "expiresAt", "createdAt")
    values (
      ${randomUUID()}, ${`refresh-${randomUUID()}`}, ${clientId}, ${userId},
      ${JSON.stringify(["cooking:read"])}::jsonb, now() + interval '30 days', now()
    )
  `);
}

async function tokenCounts(
  userId: string,
  clientId: string,
): Promise<{ access: number; refresh: number }> {
  const access = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from "oauthAccessToken"
        where "userId" = ${userId} and "clientId" = ${clientId}`,
  );
  const refresh = await db.execute<{ n: number }>(
    sql`select count(*)::int as n from "oauthRefreshToken"
        where "userId" = ${userId} and "clientId" = ${clientId}`,
  );
  return {
    access: access.rows[0]?.n ?? -1,
    refresh: refresh.rows[0]?.n ?? -1,
  };
}

/** A tool call over the in-memory transport, as the given client. */
async function callAsClient(
  userId: string,
  clientId: string,
  tool: string,
): Promise<{ error: boolean; code: string; message: string }> {
  const caller: McpCallerContext = {
    userId,
    clientId,
    scopes: new Set(MCP_SCOPES),
  };
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "agent-clients-test", version: "0.0.0" });
  await Promise.all([
    mcp.connect(clientTransport),
    buildServer(caller).connect(serverTransport),
  ]);

  try {
    const result = await mcp.callTool({ name: tool, arguments: {} });
    const content = (result as { content?: Array<{ text?: string }> }).content;
    const text = content?.[0]?.text ?? "";
    const isError = (result as { isError?: boolean }).isError === true;
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      return {
        error: isError,
        code: typeof parsed.error === "string" ? parsed.error : "",
        message: typeof parsed.message === "string" ? parsed.message : text,
      };
    } catch {
      return { error: isError, code: "", message: text };
    }
  } finally {
    await mcp.close();
  }
}

beforeAll(async () => {
  user = await setupTestUser();
  other = await setupTestUser();

  // Ordered on purpose: `listConnectedClients` sorts by `createdAt desc`, and
  // two rows written in the same statement would make that assertion vacuous.
  await seedAgentConsent(user.ctx, clientA, ["cooking:read"]);
  await seedAgentConsent(user.ctx, clientB, [...MCP_SCOPES]);
  await seedAgentConsent(other.ctx, clientOther, [...MCP_SCOPES]);

  await issueTokens(user.ctx.userId, clientA);
  await issueTokens(user.ctx.userId, clientB);
  await issueTokens(other.ctx.userId, clientOther);
});

afterAll(async () => {
  for (const clientId of [clientA, clientB, clientOther]) {
    await db.execute(
      sql`delete from "oauthAccessToken" where "clientId" = ${clientId}`,
    );
    await db.execute(
      sql`delete from "oauthRefreshToken" where "clientId" = ${clientId}`,
    );
  }
  await cleanupUser(user.ctx);
  await cleanupUser(other.ctx);
  await clearAgentConsent(user.ctx, clientA);
  await clearAgentConsent(user.ctx, clientB);
  await clearAgentConsent(other.ctx, clientOther);
});

describe("listing what is connected", () => {
  it("reports each consent with the client's registered name and its scopes", async () => {
    const connected = await listConnectedClients(user.ctx);
    const found = connected.find((row) => row.clientId === clientA);

    expect(found).toBeDefined();
    expect(found?.name).toBe("Client de test");
    // The scopes column is jsonb read as `unknown` and filtered rather than
    // cast, so a column holding anything else yields an empty list instead of
    // a function that promised strings and handed back something else.
    expect(found?.scopes).toEqual(["cooking:read"]);
    expect(found?.consentId).toBeTypeOf("string");

    /*
     * Asserted as "a usable instant" rather than `toBeInstanceOf(Date)`, and
     * that is a defect being described, not a preference.
     *
     * `ConnectedClient.connectedAt` is declared `Date` and this really is one
     * at compile time, because the type argument to `tx.execute<...>` in
     * `listConnectedClients` says so and nothing checks it. At runtime the raw
     * `execute` path hands the timestamptz back as a string, so
     * `src/app/(app)/agent/page.tsx:60` calls `Intl.DateTimeFormat.format` on a
     * string, which coerces to NaN and throws `RangeError: Invalid time value`.
     * The agent screen therefore fails for any account with a connected client.
     *
     * This assertion holds either way: it passes today and keeps passing once
     * the service returns what its type promises, so fixing the defect does not
     * turn this test red.
     */
    const connectedAt = new Date(found?.connectedAt ?? Number.NaN);
    expect(Number.isNaN(connectedAt.getTime())).toBe(false);
  });

  it("has never seen a client that has not called, rather than reporting zero time", async () => {
    const connected = await listConnectedClients(user.ctx);
    const found = connected.find((row) => row.clientId === clientA);

    // Null and not the epoch: the screen says "jamais utilisé" for one and a
    // date for the other, and a coalesce to now() here would claim a client
    // that has never called was active a moment ago.
    expect(found?.lastSeenAt).toBeNull();
    expect(found?.callsLast7Days).toBe(0);
  });

  it("counts a call the moment one happens", async () => {
    const answer = await callAsClient(user.ctx.userId, clientB, "whoami");
    expect(answer.error).toBe(false);

    const connected = await listConnectedClients(user.ctx);
    const found = connected.find((row) => row.clientId === clientB);

    // The join reaches into `agent_activity`, which does have row-level
    // security, which is why this query runs inside `inScope` even though
    // nothing else in it needs to: an unscoped read of that table returns zero
    // rows in silence, so the count would be 0 and look like an idle client.
    expect(found?.callsLast7Days).toBeGreaterThanOrEqual(1);

    // Not null any more, and a usable instant. See the note above about the
    // declared `Date` that the driver actually returns as a string.
    expect(found?.lastSeenAt).not.toBeNull();
    const lastSeen = new Date(found?.lastSeenAt ?? Number.NaN);
    expect(Number.isNaN(lastSeen.getTime())).toBe(false);
  });

  it("lists only this account's clients", async () => {
    const mine = await listConnectedClients(user.ctx);
    const theirs = await listConnectedClients(other.ctx);

    expect(mine.map((row) => row.clientId).sort()).toEqual(
      [clientA, clientB].sort(),
    );
    expect(theirs.map((row) => row.clientId)).toEqual([clientOther]);
  });
});

describe("revoking a client", () => {
  it("removes the consent and both stored tokens together", async () => {
    expect(await tokenCounts(user.ctx.userId, clientA)).toEqual({
      access: 1,
      refresh: 1,
    });

    await revokeClient(user.ctx, clientA);

    // All three statements run in one transaction. They used to run on the pool
    // separately, so a failure after the consent delete left the tokens on
    // disk: the consent check still refused every call, which is why nothing
    // looked broken, but the user had been told those credentials were
    // destroyed and they were not.
    expect(
      (await listConnectedClients(user.ctx)).map((row) => row.clientId),
    ).not.toContain(clientA);
    expect(await tokenCounts(user.ctx.userId, clientA)).toEqual({
      access: 0,
      refresh: 0,
    });
  });

  it("leaves the account's other clients alone", async () => {
    expect(
      (await listConnectedClients(user.ctx)).map((row) => row.clientId),
    ).toContain(clientB);
    expect(await tokenCounts(user.ctx.userId, clientB)).toEqual({
      access: 1,
      refresh: 1,
    });
  });

  it("refuses a client that is not connected to this account", async () => {
    const error = await expectDomainError(
      revokeClient(user.ctx, "un-client-jamais-connecte"),
      "NOT_FOUND",
    );
    expect(error.details).toMatchObject({
      clientId: "un-client-jamais-connecte",
    });
  });

  it("cannot reach another account's consent, and takes nothing with it", async () => {
    // The only thing keeping one account's clients out of another's is the
    // `userId` in each statement, because these tables have no row-level
    // security behind them. So this is the tenancy test for the whole file.
    await expectDomainError(revokeClient(user.ctx, clientOther), "NOT_FOUND");

    expect(
      (await listConnectedClients(other.ctx)).map((row) => row.clientId),
    ).toEqual([clientOther]);
    expect(await tokenCounts(other.ctx.userId, clientOther)).toEqual({
      access: 1,
      refresh: 1,
    });
  });

  it("is idempotent enough to report the second attempt honestly", async () => {
    // Not silently successful. The screen lists what is connected, so a second
    // revoke means the list the user was looking at is stale, and telling them
    // it worked would leave them believing something happened that did not.
    await expectDomainError(revokeClient(user.ctx, clientA), "NOT_FOUND");
  });
});

describe("what a revoked client can still do", () => {
  it("nothing: the next MCP call is refused with CLIENT_REVOKED", async () => {
    // The token is a JWT signed by our JWKS and is still cryptographically
    // valid, so this is the only thing standing between a revoked agent and the
    // data. It runs before any handler, on every call.
    const answer = await callAsClient(user.ctx.userId, clientA, "whoami");

    expect(answer.error).toBe(true);
    expect(answer.code).toBe("CLIENT_REVOKED");
    // Rule 10: actionable. The agent is told the token is not the problem and
    // that reconnecting is the way back, so it neither retries nor gives up on
    // the wrong diagnosis.
    expect(answer.message).toMatch(/révoqué/);
    expect(answer.message.length).toBeGreaterThan(40);
  });

  it("while the client that was not revoked still works", async () => {
    const answer = await callAsClient(user.ctx.userId, clientB, "whoami");
    expect(answer.error).toBe(false);
  });
});
