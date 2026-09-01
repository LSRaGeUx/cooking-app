import { sql } from "drizzle-orm";
import { db, withUser } from "@/db/client";
import { DomainError, isDomainError } from "@/domain/errors";
import { checkAccess } from "@/lib/access";
import { logAgentActivity } from "@/lib/activity-log";
import { agentContext, type ServiceContext } from "@/services/context";
import { ensureUserSetup } from "@/services/onboarding-service";
import type { McpCallerContext } from "./server";

/**
 * Everything that must happen around every tool call, in one place, so no tool
 * can forget one of them: scope check, revocation check, rate limit, audit log,
 * and error shaping.
 *
 * The revocation check deserves the explanation. Access tokens are JWTs
 * verified against our own JWKS, which means the token itself keeps validating
 * until it expires even after the user revokes the client. The spec says
 * revocation is effective immediately, so every call re-checks that a consent
 * row still exists for this (user, client) pair. One indexed query per call
 * buys a revoke button that actually revokes.
 */

/** Generous, but present, so a looping agent cannot fill the database. */
const RATE_LIMIT_CALLS_PER_MINUTE = 120;

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  /** The SDK's result type is open, and its handler signature requires this. */
  [key: string]: unknown;
}

export interface ToolOptions {
  readonly name: string;
  readonly direction: "read" | "write";
  readonly requiredScopes: readonly string[];
  /** Redacted and size-capped before it reaches the audit log. */
  readonly payloadSummary?: unknown;
}

/**
 * Shared by tools and resources: the checks and the audit entry are identical,
 * only the shape of the answer differs.
 */
async function guardedCall(
  caller: McpCallerContext,
  options: ToolOptions,
  fn: (ctx: ServiceContext) => Promise<string>,
): Promise<string> {
  const ctx = agentContext(caller.userId, caller.clientId ?? null);

  assertScopes(caller, options.requiredScopes);
  await assertAccountStillAllowed(caller);
  await assertClientStillAuthorized(caller);
  await assertWithinRateLimit(caller);

  // The agent may well be the first thing this account ever talks to, which is
  // the persona the product is built around. First-run seeding used to sit only
  // behind requireUser(), so a user who authorized a client before opening the
  // app had no meal types and no slots: get_week answered with an empty grid and
  // propose_week refused every entry with SLOT_UNKNOWN and an empty list of
  // valid keys, an error naming no way out and repairable by no tool. Idempotent,
  // and three indexed reads once the account is set up.
  await ensureUserSetup(ctx);

  const text = await fn(ctx);
  await log(caller, options, "ok");
  return text;
}

/**
 * Resources let a refusal propagate as a JSON-RPC error rather than as a
 * successful read with an error body: a resource that answers 200 with an error
 * inside would be cached and re-read as if it were content.
 */
export async function runResource(
  caller: McpCallerContext,
  options: ToolOptions,
  fn: (ctx: ServiceContext) => Promise<string>,
): Promise<string> {
  try {
    return await guardedCall(caller, options, fn);
  } catch (error) {
    if (isDomainError(error)) {
      await log(caller, options, "rejected", error.code);
      throw new Error(`${error.code}: ${error.message}`);
    }
    console.error(`MCP resource ${options.name} failed`, error);
    await log(caller, options, "error");
    throw error;
  }
}

export async function runTool(
  caller: McpCallerContext,
  options: ToolOptions,
  fn: (ctx: ServiceContext) => Promise<string>,
): Promise<ToolResult> {
  try {
    const text = await guardedCall(caller, options, fn);
    return { content: [{ type: "text", text }] };
  } catch (error) {
    if (isDomainError(error)) {
      await log(caller, options, "rejected", error.code);
      return errorResult(error);
    }

    console.error(`MCP tool ${options.name} failed`, error);
    await log(caller, options, "error");
    return errorResult(
      new DomainError(
        "VALIDATION",
        "Une erreur interne est survenue pendant le traitement de cet appel. Réessayez ; si cela persiste, l'utilisateur peut consulter le journal d'activité de l'agent dans l'application.",
      ),
    );
  }
}

/**
 * Errors teach. A rejection carries a machine-readable code, a reason, and,
 * wherever the rule can name one, the corrective action. A well-shaped error
 * turns a failed call into a successful retry with no human in the loop, which
 * is the highest leverage per line of code on this surface.
 */
function errorResult(error: DomainError): ToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify(
          { error: error.code, message: error.message, details: error.details },
          null,
          2,
        ),
      },
    ],
  };
}

function assertScopes(
  caller: McpCallerContext,
  required: readonly string[],
): void {
  const missing = required.filter((scope) => !caller.scopes.has(scope));
  if (missing.length === 0) return;

  throw new DomainError(
    "MISSING_SCOPE",
    `Cette connexion n'a pas les autorisations nécessaires : ${missing.join(", ")}. L'utilisateur doit reconnecter le client depuis l'écran « Agent » de l'application pour accorder ces autorisations. Autorisations actuelles : ${[...caller.scopes].sort().join(", ") || "aucune"}.`,
    { missing, granted: [...caller.scopes].sort() },
  );
}

/**
 * The allowlist decides who may hold an account, and until now it was read only
 * when a person signed in. That is the wrong moment for this surface. An access
 * token is a JWT valid for an hour whatever we later think of its holder, the
 * session cookie behind it outlives a removal too, and a surviving cookie can
 * authorize a fresh client and mint another hour on demand. So dropping an
 * address blocked the next sign-in and left every agent already connected to
 * that account working, indefinitely. Re-checking here makes removal effective
 * on the next call, the same way the consent check below makes a revoke
 * effective on the next call.
 *
 * A second indexed lookup rather than a join onto that check: the consent query
 * returns early for a caller with no client id, and this one must run for every
 * caller. Better Auth owns the table, so it is read with raw SQL.
 */
async function assertAccountStillAllowed(caller: McpCallerContext): Promise<void> {
  const rows = await db.execute<{ email: string }>(
    sql`select email from "user" where id = ${caller.userId} limit 1`,
  );

  const email = rows.rows[0]?.email;
  if (email !== undefined && checkAccess(email).allowed) return;

  throw new DomainError(
    "ACCESS_REVOKED",
    "Le compte associé à ce jeton n'a plus accès à cette instance. Ce n'est pas un problème d'autorisation du client : reconnecter le client ou demander d'autres autorisations ne changera rien, et il ne faut pas réessayer. L'utilisateur doit demander à l'administrateur de l'instance de rétablir son adresse dans la liste d'accès.",
    { retryable: false, userId: caller.userId },
  );
}

async function assertClientStillAuthorized(
  caller: McpCallerContext,
): Promise<void> {
  if (!caller.clientId) return;

  // Better Auth owns this table, so it is read with raw SQL rather than through
  // the Drizzle schema, which deliberately describes only the domain tables.
  const rows = await db.execute(
    sql`select 1 from "oauthConsent" where "userId" = ${caller.userId} and "clientId" = ${caller.clientId} limit 1`,
  );

  if (rows.rows.length === 0) {
    throw new DomainError(
      "CLIENT_REVOKED",
      "L'accès de ce client a été révoqué par l'utilisateur. Le jeton reste valide jusqu'à son expiration mais n'ouvre plus aucune donnée. Demandez à l'utilisateur de reconnecter le client s'il souhaite rétablir l'accès.",
      { clientId: caller.clientId },
    );
  }
}

async function assertWithinRateLimit(caller: McpCallerContext): Promise<void> {
  if (!caller.clientId) return;

  // Counted from the audit log rather than from memory, so the limit holds
  // across processes and needs no shared cache.
  //
  // It must run inside withUser. agent_activity is under row-level security, so
  // an unscoped count returns zero rather than erroring, and a rate limiter
  // that always counts zero is a rate limiter that does not exist.
  const rows = await withUser(caller.userId, (tx) =>
    tx.execute<{ calls: number }>(
      sql`select count(*)::int as calls from agent_activity
          where oauth_client_id = ${caller.clientId}
            and created_at > now() - interval '1 minute'`,
    ),
  );

  const calls = rows.rows[0]?.calls ?? 0;
  if (calls < RATE_LIMIT_CALLS_PER_MINUTE) return;

  throw new DomainError(
    "RATE_LIMITED",
    `Ce client a dépassé ${RATE_LIMIT_CALLS_PER_MINUTE} appels par minute. Attendez une minute avant de réessayer, et regroupez vos lectures : la ressource « cooking://recipes/index » donne toute la bibliothèque en un seul appel.`,
    { limitPerMinute: RATE_LIMIT_CALLS_PER_MINUTE, callsInLastMinute: calls },
  );
}

async function log(
  caller: McpCallerContext,
  options: ToolOptions,
  result: "ok" | "rejected" | "error",
  rejectionCode?: string,
): Promise<void> {
  try {
    await logAgentActivity({
      userId: caller.userId,
      oauthClientId: caller.clientId,
      toolName: options.name,
      direction: options.direction,
      result,
      ...(rejectionCode ? { rejectionCode } : {}),
      payloadSummary: options.payloadSummary ?? null,
    });
  } catch (error) {
    // A failed audit write must not swallow a successful call, but it must not
    // pass silently either.
    console.error("Failed to write agent activity", error);
  }
}

/**
 * Payload summaries are stored, so they are capped and stripped of anything
 * long. The log is a product feature the user reads, not a debug dump.
 */
export function summarize(input: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string") {
      summary[key] = value.length > 80 ? `${value.slice(0, 80)}…` : value;
    } else if (Array.isArray(value)) {
      summary[key] = `${value.length} éléments`;
    } else if (typeof value === "object") {
      summary[key] = "objet";
    } else {
      summary[key] = value;
    }
  }
  return summary;
}
