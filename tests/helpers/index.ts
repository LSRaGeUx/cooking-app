import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { getTableName, is, sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { db, withUser } from "@/db/client";
import * as schema from "@/db/schema";
import { formatCycleStart } from "@/domain/shopping";
import { DomainError } from "@/domain/errors";
import { isoWeekStart, type IsoWeek } from "@/domain/week";
import { ensureUserSetup } from "@/services/onboarding-service";
import { listMealTypes } from "@/services/slot-service";
import { userContext, type ServiceContext } from "@/services/context";
import { testUser } from "./fixtures";

/**
 * The four things every test file in this suite was writing for itself.
 *
 * Each one existed in between four and ten copies, and the copies had drifted:
 * the `try/catch` then `thrown as DomainError` form turned "it did not throw"
 * into a `TypeError` about reading `code` of `undefined`, which reads as a crash
 * in the service rather than as a failed expectation, and the hand-listed
 * cleanup order in fixtures.ts silently stopped covering a table the moment one
 * was added.
 */

/**
 * Asserts that `promise` rejects with a `DomainError` carrying `code`, and hands
 * the error back so a caller can go on to assert on `details`.
 *
 * The failure messages are the point. A promise that resolves fails with the
 * value it resolved to, and a rejection with the wrong code fails naming both
 * codes and the message the service wrote, so a genuine change of behaviour is
 * readable from the report without opening the file.
 */
export async function expectDomainError(
  promise: Promise<unknown>,
  code: string,
): Promise<DomainError> {
  let thrown: unknown;
  let resolved: unknown;
  let didResolve = false;

  try {
    resolved = await promise;
    didResolve = true;
  } catch (error) {
    thrown = error;
  }

  return assertDomainError({ thrown, resolved, didResolve }, code);
}

/**
 * The same assertion for a function that throws rather than rejects.
 *
 * The pure domain guards, `assertPrepOrder` and the slot checks, are
 * synchronous, and wrapping each one in a promise to reach the async helper
 * would put a `Promise.resolve().then(...)` in front of every assertion for
 * nothing. One implementation underneath both, so a failure reads identically
 * whichever side of the layer it came from.
 */
export function expectDomainErrorSync(
  fn: () => unknown,
  code: string,
): DomainError {
  let thrown: unknown;
  let resolved: unknown;
  let didResolve = false;

  try {
    resolved = fn();
    didResolve = true;
  } catch (error) {
    thrown = error;
  }

  return assertDomainError({ thrown, resolved, didResolve }, code);
}

function assertDomainError(
  outcome: { thrown: unknown; resolved: unknown; didResolve: boolean },
  code: string,
): DomainError {
  const { thrown, resolved, didResolve } = outcome;

  if (didResolve) {
    expect.fail(
      `Expected a DomainError with code ${code}, but the call resolved with ` +
        `${JSON.stringify(resolved)}.`,
    );
  }

  if (!(thrown instanceof DomainError)) {
    expect.fail(
      `Expected a DomainError with code ${code}, but got ` +
        `${thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown)}.`,
    );
  }

  expect(
    thrown.code,
    `Wrong DomainError code. The service said: ${thrown.message}`,
  ).toBe(code);

  return thrown;
}

/**
 * Every user-owned table, derived from the Drizzle schema rather than listed by
 * hand, with the tables that reference another one first.
 *
 * Two tests depend on the enumeration being complete rather than current:
 * `tests/rls.test.ts` asserts row-level security on all of them and
 * `tests/services/account.test.ts` asserts deletion empties all of them. A
 * hand-written list passes both the day a table is added, which is the day the
 * assertion needed to fail.
 *
 * The order is a topological sort over the foreign keys Drizzle already knows
 * about, so `cleanupUser` can delete children before parents without anyone
 * maintaining a sequence.
 */
export interface UserOwnedTable {
  readonly name: string;
  readonly table: PgTable;
}

function ownedTablesUnordered(): { name: string; table: PgTable }[] {
  const found: { name: string; table: PgTable }[] = [];
  for (const value of Object.values(schema)) {
    if (!is(value, PgTable)) continue;
    const config = getTableConfig(value);
    if (!config.columns.some((column) => column.name === "user_id")) continue;
    found.push({ name: getTableName(value), table: value });
  }
  return found;
}

export function userOwnedTables(): UserOwnedTable[] {
  const tables = ownedTablesUnordered();
  const byName = new Map(tables.map((entry) => [entry.name, entry]));

  // A table's dependencies are the user-owned tables it points at. Self
  // references are dropped: `plan_version.superseded_by` points at its own
  // table, which is not an ordering constraint between tables.
  const dependencies = new Map<string, string[]>();
  for (const entry of tables) {
    const targets = new Set<string>();
    for (const key of getTableConfig(entry.table).foreignKeys) {
      const target = getTableName(key.reference().foreignTable);
      if (target !== entry.name && byName.has(target)) targets.add(target);
    }
    dependencies.set(entry.name, [...targets]);
  }

  // Children first: a table is emitted only once everything that points at it
  // has been emitted, so deleting in this order never trips a foreign key.
  const ordered: UserOwnedTable[] = [];
  const emitted = new Set<string>();
  const dependants = new Map<string, string[]>();
  for (const entry of tables) dependants.set(entry.name, []);
  for (const [name, targets] of dependencies) {
    for (const target of targets) dependants.get(target)?.push(name);
  }

  let progress = true;
  while (progress) {
    progress = false;
    for (const entry of tables) {
      if (emitted.has(entry.name)) continue;
      const waitingOn = dependants
        .get(entry.name)
        ?.filter((name) => !emitted.has(name));
      if (waitingOn && waitingOn.length > 0) continue;
      ordered.push(entry);
      emitted.add(entry.name);
      progress = true;
    }
  }

  // A cycle would leave tables unemitted. Append them rather than hide them:
  // the enumeration must stay complete even if the ordering cannot be decided,
  // because two tests read it as "every user-owned table".
  for (const entry of tables) {
    if (!emitted.has(entry.name)) ordered.push(entry);
  }

  return ordered;
}

/** Just the table names, which is what a SQL-level test wants. */
export function userOwnedTableNames(): string[] {
  return userOwnedTables().map((entry) => entry.name);
}

/**
 * Deletes everything a test user owns. Derived from `userOwnedTables()`, so a
 * table added to the schema is cleaned up without anyone editing this.
 *
 * The suite truncates the whole database before a run, so this is about
 * isolation *within* a run: a user left behind by one file is a user whose
 * allergens block a recipe in the next.
 */
export async function cleanupUser(ctx: ServiceContext): Promise<void> {
  const tables = userOwnedTables();
  await withUser(ctx.userId, async (tx) => {
    for (const entry of tables) {
      // Raw SQL rather than the typed builder: the column is `user_id` on every
      // one of these tables by construction, and typing the builder over a
      // heterogeneous list of tables costs a cast per table for nothing.
      await tx.execute(
        sql`delete from ${sql.identifier(entry.name)} where user_id = ${ctx.userId}`,
      );
    }
  });
}

/**
 * A user with the starter setup done and the dinner meal type resolved, which
 * is the first six lines of every service test file.
 *
 * `dinnerId` is here because `(await listMealTypes(ctx)).find((t) => t.key ===
 * "dinner")!.id` appeared in eight files, and the `!` in it is exactly the
 * non-null assertion the codebase now bans in `src/`.
 */
export async function setupTestUser(): Promise<{
  ctx: ServiceContext;
  dinnerId: string;
  lunchId: string;
  cleanup: () => Promise<void>;
}> {
  const ctx = testUser();
  await ensureUserSetup(ctx);
  const mealTypes = await listMealTypes(ctx);

  const dinner = mealTypes.find((type) => type.key === "dinner");
  const lunch = mealTypes.find((type) => type.key === "lunch");
  if (!dinner || !lunch) {
    throw new Error(
      `ensureUserSetup did not seed the expected meal types. Got: ${mealTypes
        .map((type) => type.key)
        .join(", ")}`,
    );
  }

  return {
    ctx,
    dinnerId: dinner.id,
    lunchId: lunch.id,
    cleanup: () => cleanupUser(ctx),
  };
}

/**
 * The shopping cycle a week is bought for. Grocery lists cover a cycle rather
 * than a week, and a test that plans by week shops on the Monday cycle of that
 * week, which is the fallback an account with no shopping day set gets.
 *
 * Was copied, docblock and all, into four test files.
 */
export function cycleOf(week: IsoWeek): string {
  return formatCycleStart(isoWeekStart(week));
}

/**
 * The Postgres error code behind a driver error, or undefined when the error
 * did not come from the driver.
 *
 * The tests that assert 42501 (RLS or privilege refusal), 23505 (unique
 * violation) and 23503 (foreign key violation) each reached for it through
 * their own `e as { cause?: { code?: string } }` cast. Drizzle wraps the
 * `pg` error, so the code is one `cause` down, and a test that read
 * `(error as { code?: string }).code` directly silently asserted `undefined`
 * against `undefined` and passed for the wrong reason.
 */
export function pgCodeOf(error: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (
    current !== null &&
    typeof current === "object" &&
    !seen.has(current)
  ) {
    seen.add(current);
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }

  return undefined;
}

/**
 * An account, a registered agent client, and a consent between them.
 *
 * Every MCP call passes `assertCallerStillAuthorized`, which joins Better
 * Auth's `user` and `oauthConsent` tables, so a tool call from a client with no
 * consent row is refused before the handler runs. A test that skips this gets
 * every call refused and, without knowing why, reads it as the tool being
 * broken.
 *
 * The raw SQL is deliberate and it is a liability worth naming. These are
 * Better Auth's own tables, in its own camelCase, and it migrates them itself,
 * so a library upgrade that renames a column breaks this fixture rather than
 * the code it stands in for. It is in one place for that reason: when the
 * upgrade comes, there is one query to fix rather than one per test file.
 *
 * `oauthConsent.userId` has a real foreign key to `user`, unlike the domain
 * tables, so a bare uuid will not do: the account row has to exist.
 */
export async function seedAgentConsent(
  ctx: ServiceContext,
  clientId: string,
  scopes: readonly string[],
): Promise<void> {
  await db.execute(sql`
    insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
    values (${ctx.userId}, 'Test', ${`${ctx.userId}@example.test`}, false, now(), now())
    on conflict do nothing
  `);
  await db.execute(sql`
    insert into "oauthClient" (id, "clientId", name, "redirectUris", "createdAt", "updatedAt")
    values (
      ${randomUUID()}, ${clientId}, 'Client de test',
      ${JSON.stringify(["http://localhost:9999/callback"])}::jsonb, now(), now()
    )
    on conflict do nothing
  `);
  await db.execute(sql`
    insert into "oauthConsent" (id, "clientId", "userId", scopes, "createdAt", "updatedAt")
    values (
      ${randomUUID()}, ${clientId}, ${ctx.userId},
      ${JSON.stringify([...scopes])}::jsonb, now(), now()
    )
    on conflict do nothing
  `);
}

/** Undoes `seedAgentConsent`, including the account row it created. */
export async function clearAgentConsent(
  ctx: ServiceContext,
  clientId: string,
): Promise<void> {
  await db.execute(
    sql`delete from "oauthConsent" where "clientId" = ${clientId}`,
  );
  await db.execute(
    sql`delete from "oauthClient" where "clientId" = ${clientId}`,
  );
  await withUser(ctx.userId, async (tx) => {
    await tx.execute(
      sql`delete from agent_activity where oauth_client_id = ${clientId}`,
    );
  });
  await db.execute(sql`delete from "user" where id = ${ctx.userId}`);
}

/** A plain user context with no setup run, for a test that wants a bare tenant. */
export { testUser, userContext };
