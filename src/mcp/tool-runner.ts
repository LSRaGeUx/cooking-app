import { sql } from "drizzle-orm";
import { ZodError } from "zod";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { db, withUser, type Tx } from "@/db/client";
import {
  DomainError,
  isDomainError,
  type DomainErrorDetails,
} from "@/domain/errors";
import type { ActivityResult } from "@/domain/vocabulary";
import { checkAccess } from "@/lib/access";
import { logAgentActivity, logAgentActivityIn } from "@/lib/activity-log";
import { agentContext, type ServiceContext } from "@/services/context";
import { ensureUserSetup } from "@/services/onboarding-service";
import { toolJson } from "./serializers";
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

/**
 * An internal failure is not a validation failure.
 *
 * This branch used to answer `VALIDATION`, which the taxonomy defines as a
 * schema rejection carrying a field path. An agent reading that will edit its
 * arguments and retry, forever, against a server bug its arguments had nothing
 * to do with. `INTERNAL` says the opposite: the call was well formed, the
 * failure is ours, and `details.retryable` says whether trying again is worth
 * anything.
 *
 * **It is not in `BLOCKING_CODES` yet.** `src/domain/errors.ts` belongs to the
 * domain agent and the taxonomy entry is pending, along with the matching row in
 * docs/03-agent-interface.md section 6, so the code travels as a string here
 * rather than through `DomainError`. Once it is in the tuple this becomes a
 * `DomainError` like every other refusal.
 */
const INTERNAL = "INTERNAL";

const INTERNAL_MESSAGE =
  "Une erreur interne est survenue pendant le traitement de cet appel. Votre appel n'est pas en cause : ne le corrigez pas. Réessayez une fois ; si cela persiste, l'utilisateur peut consulter le journal d'activité de l'agent dans l'application.";

/**
 * A Zod failure is the agent's fault, and it must not be reported as ours.
 *
 * The services parse their input with the domain schemas, which is what makes
 * Zod the single source of truth rather than a second opinion. The consequence
 * is that a service can throw a `ZodError` rather than a `DomainError`, and
 * before this it fell through to the `INTERNAL` branch below, which carries
 * `retryable: true` and tells an agent in as many words not to change its
 * arguments. So a call with a blank name was answered with "the server broke,
 * try again", and the identical call would fail forever.
 *
 * `VALIDATION` with the field path is the honest answer, and it is the same
 * shape `runAction` returns for the same cause in src/app/actions/result.ts, so
 * the two entry points do not disagree about what a schema violation is.
 *
 * Zod's own messages are English and untranslatable, so the path is what
 * travels, plus the issues for an agent that wants to be precise. The sentence
 * is ours.
 */
function validationErrorFrom(error: ZodError): DomainError {
  const [first] = error.issues;
  const field = first && first.path.length > 0 ? first.path.join(".") : null;
  return new DomainError(
    "VALIDATION",
    field && first
      ? `Le paramètre \`${field}\` est invalide : ${first.message}. Corrigez-le et rappelez l'outil.`
      : `Les paramètres de cet appel sont invalides : ${first?.message ?? "forme inattendue"}. Corrigez-les et rappelez l'outil.`,
    {
      ...(field ? { field } : {}),
      issues: error.issues,
    } as DomainErrorDetails,
  );
}

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
  /** Redacted and size-capped by `summarize` before it reaches the audit log. */
  readonly payloadSummary?: Record<string, unknown>;
  /**
   * Whether the call and its audit row share one transaction. Defaults to true
   * for a write, which is what makes an agent write attributable: the work and
   * the row that names who did it commit together or not at all.
   *
   * One tool sets it false, and the reason is worth stating rather than leaving
   * to be discovered. `import_recipe_from_url` fetches an arbitrary third-party
   * page before it writes anything, and wrapping it would hold a Postgres
   * transaction open across that fetch: idle in transaction for as long as a
   * slow site takes to answer, on every import, which is how a pool runs out of
   * connections. Its audit row is therefore written after the commit, with the
   * same gap every read has.
   */
  readonly transactional?: boolean;
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
  const ctx = agentContext(caller.userId, caller.clientId);

  assertScopes(caller, options.requiredScopes);
  await assertCallerStillAuthorized(caller);
  await assertWithinRateLimit(caller);

  // The agent may well be the first thing this account ever talks to, which is
  // the persona the product is built around. First-run seeding used to sit only
  // behind requireUser(), so a user who authorized a client before opening the
  // app had no meal types and no slots: get_week answered with an empty grid and
  // propose_week refused every entry with SLOT_UNKNOWN and an empty list of
  // valid keys, an error naming no way out and repairable by no tool. Idempotent,
  // and three indexed reads once the account is set up.
  await ensureUserSetup(ctx);

  const transactional = options.transactional ?? options.direction === "write";
  if (!transactional) {
    const text = await fn(ctx);
    await log(caller, options, "ok");
    return text;
  }

  // The audit row is written on the tool's own transaction, so a write that
  // commits cannot be unattributed and a row that rolls back leaves no claim
  // that it succeeded. Re-entrant by design: every service reaches the database
  // through `inScope`, which reuses `ctx.tx` when there is one.
  return withUser(caller.userId, async (tx) => {
    const text = await fn({ ...ctx, tx });
    await logIn(tx, caller, options, "ok");
    return text;
  });
}

/**
 * Resources let a refusal propagate as a JSON-RPC error rather than as a
 * successful read with an error body: a resource that answers 200 with an error
 * inside would be cached and re-read as if it were content.
 *
 * It is the SDK's `McpError` rather than a bare `Error`, because the transport
 * serializes `data` into the JSON-RPC error object and drops everything else. A
 * plain `new Error("CODE: message")` collapsed the whole refusal into one
 * string, so the `details` bag, which is where the valid alternatives live, was
 * built by the domain and then thrown away one layer below the client.
 */
export async function runResource(
  caller: McpCallerContext,
  options: ToolOptions,
  fn: (ctx: ServiceContext) => Promise<string>,
): Promise<string> {
  try {
    return await guardedCall(caller, options, fn);
  } catch (error) {
    const domain =
      error instanceof ZodError ? validationErrorFrom(error) : error;
    if (isDomainError(domain)) {
      await log(caller, options, "rejected", domain.code);
      throw new McpError(ErrorCode.InvalidParams, domain.message, {
        code: domain.code,
        details: domain.details,
      });
    }
    console.error(`MCP resource ${options.name} failed`, error);
    await log(caller, options, "error");
    throw new McpError(ErrorCode.InternalError, INTERNAL_MESSAGE, {
      code: INTERNAL,
      details: { retryable: true },
    });
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
    const domain =
      error instanceof ZodError ? validationErrorFrom(error) : error;
    if (isDomainError(domain)) {
      await log(caller, options, "rejected", domain.code);
      return errorResult(domain);
    }

    console.error(`MCP tool ${options.name} failed`, error);
    await log(caller, options, "error");
    return errorResult({
      code: INTERNAL,
      message: INTERNAL_MESSAGE,
      // The call was well formed. Retrying can help, editing the arguments
      // cannot, and that distinction is the whole reason this code exists.
      details: { retryable: true },
    });
  }
}

/**
 * Errors teach. A rejection carries a machine-readable code, a reason, and,
 * wherever the rule can name one, the corrective action. A well-shaped error
 * turns a failed call into a successful retry with no human in the loop, which
 * is the highest leverage per line of code on this surface.
 *
 * It takes a code as a string rather than a `DomainError`, because `INTERNAL` is
 * not in the taxonomy tuple yet and a cast to pretend otherwise would outlive
 * the reason for it.
 */
function errorResult(error: {
  readonly code: string;
  readonly message: string;
  readonly details?: DomainErrorDetails;
}): ToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: toolJson({
          error: error.code,
          message: error.message,
          details: error.details ?? {},
        }),
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
 * Two questions, one round trip: does this account still have access to the
 * instance, and does this client still have a consent on it.
 *
 * Both used to be their own indexed lookup, on the reasoning that the consent
 * query returns early for a caller with no client id. That saved a subquery on
 * the rare path and paid a round trip on every single call, which is the wrong
 * side of the trade on a surface an agent hits in a loop. Better Auth owns both
 * tables, so they are read with raw SQL rather than through the Drizzle schema,
 * which deliberately describes only the domain tables.
 *
 * The allowlist half is why this runs at all. It used to be read only when a
 * person signed in, and that is the wrong moment for this surface. An access
 * token is a JWT valid for its full hour whatever we later think of its holder,
 * the session cookie behind it outlives a removal too, and a surviving cookie
 * can authorize a fresh client and mint another hour on demand. So dropping an
 * address blocked the next sign-in and left every agent already connected to
 * that account working, indefinitely. Re-checking here makes removal effective
 * on the next call, the same way the consent check makes a revoke effective on
 * the next call.
 */
async function assertCallerStillAuthorized(
  caller: McpCallerContext,
): Promise<void> {
  const { clientId } = caller;
  const consented =
    clientId === null
      ? sql`true`
      : sql`exists (
            select 1 from "oauthConsent" c
            where c."userId" = u.id and c."clientId" = ${clientId}
          )`;

  const rows = await db.execute<{ email: string; consented: boolean }>(
    sql`select u.email as email, ${consented} as consented
        from "user" u
        where u.id = ${caller.userId}
        limit 1`,
  );

  const [row] = rows.rows;

  if (!row || !checkAccess(row.email).allowed) {
    throw new DomainError(
      "ACCESS_REVOKED",
      "Le compte associé à ce jeton n'a plus accès à cette instance. Ce n'est pas un problème d'autorisation du client : reconnecter le client ou demander d'autres autorisations ne changera rien, et il ne faut pas réessayer. L'utilisateur doit demander à l'administrateur de l'instance de rétablir son adresse dans la liste d'accès.",
      { retryable: false, userId: caller.userId },
    );
  }

  if (!row.consented) {
    throw new DomainError(
      "CLIENT_REVOKED",
      "L'accès de ce client a été révoqué par l'utilisateur. Le jeton reste valide jusqu'à son expiration mais n'ouvre plus aucune donnée. Demandez à l'utilisateur de reconnecter le client s'il souhaite rétablir l'accès.",
      { clientId },
    );
  }
}

async function assertWithinRateLimit(caller: McpCallerContext): Promise<void> {
  const { clientId } = caller;
  if (clientId === null) return;

  // Counted from the audit log rather than from memory, so the limit holds
  // across processes and needs no shared cache.
  //
  // It must run inside withUser. agent_activity is under row-level security, so
  // an unscoped count returns zero rather than erroring, and a rate limiter
  // that always counts zero is a rate limiter that does not exist.
  //
  // **It counts completed calls only, and that gap is accepted rather than
  // closed.** The audit row lands when the call finishes, so N calls in flight
  // at once all read the same count and all pass. Closing it would mean
  // inserting a row before the work, which needs a `result` value meaning
  // "started", and `agent_activity.result` now carries a check constraint
  // holding exactly ok, rejected and error. So the limit is a brake on a looping
  // agent, which is what it was written for, and not a concurrency control.
  const rows = await withUser(caller.userId, (tx) =>
    tx.execute<{ calls: number }>(
      sql`select count(*)::int as calls from agent_activity
          where oauth_client_id = ${clientId}
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

/**
 * The audit write on its own transaction, for a read and for the two failure
 * paths, where there is no transaction left to join.
 *
 * A failed audit write must not swallow a successful call, but it must not pass
 * silently either. On the write path `logIn` is used instead and its failure
 * takes the whole call down with it, which is the point.
 */
async function log(
  caller: McpCallerContext,
  options: ToolOptions,
  result: ActivityResult,
  rejectionCode?: string,
): Promise<void> {
  try {
    await logAgentActivity(activityRow(caller, options, result, rejectionCode));
  } catch (error) {
    console.error("Failed to write agent activity", error);
  }
}

async function logIn(
  tx: Tx,
  caller: McpCallerContext,
  options: ToolOptions,
  result: ActivityResult,
): Promise<void> {
  await logAgentActivityIn(tx, activityRow(caller, options, result));
}

function activityRow(
  caller: McpCallerContext,
  options: ToolOptions,
  result: ActivityResult,
  rejectionCode?: string,
) {
  return {
    userId: caller.userId,
    oauthClientId: caller.clientId,
    toolName: options.name,
    direction: options.direction,
    result,
    ...(rejectionCode ? { rejectionCode } : {}),
    ...(options.payloadSummary
      ? { payloadSummary: summarize(options.payloadSummary) }
      : {}),
  };
}

/**
 * Payload summaries are stored, so they are capped and stripped of anything
 * long. The log is a product feature the user reads, not a debug dump.
 *
 * It is applied here rather than left to the tools. It was exported and called
 * from nowhere, while the tools hand-built their summaries and two of them
 * passed unbounded user input straight in: a 2000-character URL from
 * `import_recipe_from_url`, and the raw query string from `search_recipes`. A
 * cap that every caller has to remember is a cap that one caller forgets.
 */
function summarize(input: Record<string, unknown>): Record<string, unknown> {
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
