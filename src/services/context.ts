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

/**
 * A context that is definitely inside a transaction, which is what every
 * private helper in the service layer actually wants.
 *
 * It exists because the type was spelled out by hand, as
 * `ServiceContext & { tx: NonNullable<ServiceContext["tx"]> }`, at about twenty
 * signatures, and the matching value was rebuilt as `{ ...ctx, tx }` at about
 * thirty call sites. `inScope` now hands one to its callback, so neither
 * spelling is needed anywhere.
 */
export type ScopedContext = ServiceContext & {
  tx: NonNullable<ServiceContext["tx"]>;
};

export function userContext(userId: string): ServiceContext {
  return { userId, actor: "user", clientId: null };
}

export function agentContext(
  userId: string,
  clientId: string | null,
): ServiceContext {
  return { userId, actor: "agent", clientId };
}

/**
 * Runs `fn` with the tenancy scope set, reusing the caller's transaction when
 * there is one. Re-entrant on purpose: a plan version write calls the recipe
 * and profile services and all of it has to commit or roll back together.
 *
 * The callback receives a `ScopedContext` rather than a bare `Tx`. Handing over
 * the transaction alone meant every service that wanted to call another one
 * rebuilt `{ ...ctx, tx }` itself, and a call that forgot opened a second
 * transaction that could commit while the outer one rolled back. The queries
 * read `scoped.tx`, which is the same handle.
 */
export async function inScope<T>(
  ctx: ServiceContext,
  fn: (scoped: ScopedContext) => Promise<T>,
): Promise<T> {
  if (ctx.tx) return fn({ ...ctx, tx: ctx.tx });
  return withUser(ctx.userId, (tx) => fn({ ...ctx, tx }));
}
