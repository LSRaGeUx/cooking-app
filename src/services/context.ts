import { withUser, type Tx } from "@/db/client";

/**
 * Who is calling, and in which transaction.
 *
 * Both entry points build one of these and pass it to the same services, which
 * is what keeps a rule from existing in only one of them. `actor` is not
 * decoration: several rules differ by caller (a rationale is required for an
 * agent-written entry, an agent-written fact enters unconfirmed), and the
 * service reads it here rather than trusting a flag in the payload.
 */
export interface ServiceContext {
  readonly userId: string;
  readonly actor: "user" | "agent";
  /** Which registered MCP client acted, stamped on agent writes. */
  readonly clientId?: string | null;
  /** Set when this call is already inside a scoped transaction. */
  readonly tx?: Tx;
}

export function userContext(userId: string): ServiceContext {
  return { userId, actor: "user", clientId: null };
}

export function agentContext(
  userId: string,
  clientId: string | null,
): ServiceContext {
  return { userId, actor: "agent", clientId };
}

export function withTx(ctx: ServiceContext, tx: Tx): ServiceContext {
  return { ...ctx, tx };
}

/**
 * Runs `fn` with the tenancy scope set, reusing the caller's transaction when
 * there is one. Re-entrant on purpose: a plan version write calls the recipe
 * and profile services and all of it has to commit or roll back together.
 */
export async function inScope<T>(
  ctx: ServiceContext,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (ctx.tx) return fn(ctx.tx);
  return withUser(ctx.userId, fn);
}
