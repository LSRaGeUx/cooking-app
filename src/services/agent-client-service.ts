import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { DomainError } from "@/domain/errors";
import { inScope, type ServiceContext } from "./context";

/**
 * Connected MCP clients, and revoking them.
 *
 * These queries reach into Better Auth's tables, which are outside the Drizzle
 * schema and outside row-level security. There is therefore no second line of
 * defence on those rows: every statement scopes by `userId` explicitly, and
 * that is the only thing keeping one account's clients out of another's. Treat
 * any edit to this file as a tenancy change.
 *
 * The one query that also touches a domain table still runs inside `inScope`,
 * because that table does have row-level security and an unscoped read of it
 * returns zero rows in silence.
 */

export interface ConnectedClient {
  readonly consentId: string;
  readonly clientId: string;
  readonly name: string | null;
  readonly scopes: string[];
  readonly connectedAt: Date;
  readonly lastSeenAt: Date | null;
  readonly callsLast7Days: number;
}

export async function listConnectedClients(
  ctx: ServiceContext,
): Promise<ConnectedClient[]> {
  // Scoped through inScope even though oauthConsent has no row-level security:
  // the join reaches into agent_activity, which does, and an unscoped read of
  // it returns zero rows rather than erroring. That is the intended failure
  // mode for tenancy and a silent wrong answer for anything else.
  /**
   * `created_at` and `last_seen_at` are `string | Date`, not `Date`, and that
   * matters.
   *
   * The type argument to `tx.execute` is an unchecked assertion: Drizzle does
   * not verify it against what the driver returns, and the raw execute path
   * hands back a `timestamptz` as a string (`'2026-09-07 18:28:24.28+00'`)
   * rather than as a `Date`, because no column type is in play to parse it.
   *
   * Declaring `Date` here made the compiler agree with a value that was a
   * string, and the screen that renders it crashed: `Intl.DateTimeFormat`
   * coerces its argument with `ToNumber`, a date string gives `NaN`, and
   * `format(NaN)` throws `RangeError: Invalid time value`. So the agent
   * connections page threw for any account that had ever connected a client,
   * and nothing in the types or the tests saw it.
   *
   * The honest type plus a coercion in the mapper is the fix. Keep both.
   */
  const rows = await inScope(ctx, ({ tx }) =>
    tx.execute<{
      consent_id: string;
      client_id: string;
      name: string | null;
      scopes: unknown;
      created_at: string | Date;
      last_seen_at: string | Date | null;
      calls_last_7_days: number;
    }>(sql`
    select c.id            as consent_id,
           c."clientId"    as client_id,
           cl.name         as name,
           c.scopes        as scopes,
           c."createdAt"   as created_at,
           a.last_seen_at  as last_seen_at,
           coalesce(a.calls, 0)::int as calls_last_7_days
    from "oauthConsent" c
    left join "oauthClient" cl on cl."clientId" = c."clientId"
    left join (
      select oauth_client_id,
             max(created_at) as last_seen_at,
             count(*) filter (where created_at > now() - interval '7 days') as calls
      from agent_activity
      group by oauth_client_id
    ) a on a.oauth_client_id = c."clientId"
    where c."userId" = ${ctx.userId}
    order by c."createdAt" desc
  `),
  );

  return rows.rows.map((row) => ({
    consentId: row.consent_id,
    clientId: row.client_id,
    name: row.name,
    // Better Auth stores the scopes as jsonb and this query reads them as
    // `unknown`, so they are filtered rather than cast: a cast would have this
    // function promise strings for whatever that column happens to hold.
    scopes: Array.isArray(row.scopes)
      ? row.scopes.filter((scope): scope is string => typeof scope === "string")
      : [],
    connectedAt: toDate(row.created_at),
    lastSeenAt: row.last_seen_at === null ? null : toDate(row.last_seen_at),
    callsLast7Days: Number(row.calls_last_7_days),
  }));
}

/** A timestamp from a raw query, whichever of the two shapes the driver used. */
function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

/**
 * Revocation, effective immediately.
 *
 * Deleting the consent alone would not be enough: access tokens are JWTs
 * verified against our JWKS, so an issued one keeps validating until it
 * expires. Three things make the revoke real. The stored tokens go, the refresh
 * tokens go so nothing can be minted again, and every MCP call re-checks that a
 * consent row still exists (see src/mcp/tool-runner.ts), which is what closes
 * the window on a token already in an agent's hands.
 */
export async function revokeClient(
  ctx: ServiceContext,
  clientId: string,
): Promise<void> {
  // One transaction for all three statements. They used to run on the pool
  // separately, so a failure after the consent delete left the access and
  // refresh tokens in place: the consent check in src/mcp/tool-runner.ts still
  // refuses the call, which is why nothing was visibly broken, but a revoke
  // that half happened leaves credentials on disk that the user was told were
  // destroyed. Either all three go or none does.
  await db.transaction(async (tx) => {
    const consents = await tx.execute(
      sql`delete from "oauthConsent" where "userId" = ${ctx.userId} and "clientId" = ${clientId} returning id`,
    );

    if (consents.rows.length === 0) {
      throw new DomainError(
        "NOT_FOUND",
        "Ce client n'est pas connecté à votre compte.",
        { clientId },
      );
    }

    await tx.execute(
      sql`delete from "oauthAccessToken" where "userId" = ${ctx.userId} and "clientId" = ${clientId}`,
    );
    await tx.execute(
      sql`delete from "oauthRefreshToken" where "userId" = ${ctx.userId} and "clientId" = ${clientId}`,
    );
  });
}
