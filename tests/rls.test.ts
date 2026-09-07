import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, withUser } from "@/db/client";
import { agentActivity } from "@/db/schema";
import { testUser } from "./helpers/fixtures";
import { cleanupUser, pgCodeOf, userOwnedTableNames } from "./helpers";
import { seedEveryUserOwnedTable } from "./helpers/seed";

/**
 * Rule 7 of CLAUDE.md, on every user-owned table rather than on one of them.
 *
 * This file used to name `agent_activity` and stop there, which pinned the
 * mechanism and not the rule: twenty-one other tables carry a `user_id` and
 * nothing checked that any of them had row-level security switched on, a policy
 * attached, or a scope that actually held. A table shipped without
 * `.enableRLS()` or without `ownerPolicy(...)` would have passed the suite.
 *
 * The enumeration is deliberately taken from two independent places and
 * cross-checked:
 *
 * - `information_schema.columns`, which is the live database and therefore the
 *   authority on what exists;
 * - `userOwnedTables()` in tests/helpers, derived from the Drizzle schema, which
 *   is the authority on what the application believes exists.
 *
 * A disagreement is itself a finding. A migration that created a user-owned
 * table nobody added to the schema files is invisible to the application and
 * visible here, and a schema table missing from the database means the test
 * database is behind the migrations.
 *
 * Everything runs against the real Postgres from compose.yaml, connected as the
 * non-owner role, because row-level security is exactly the kind of rule a mock
 * would happily pretend to enforce. Postgres exempts a table owner from its own
 * policies, so a suite connected as the owner would pass every assertion below
 * while proving nothing.
 */

/** Every table in the live database carrying a `user_id` column. */
async function tablesWithUserIdColumn(): Promise<string[]> {
  const result = await db.execute<{ table_name: string }>(sql`
    select c.table_name
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema
       and t.table_name = c.table_name
     where c.table_schema = 'public'
       and c.column_name = 'user_id'
       and t.table_type = 'BASE TABLE'
     order by c.table_name
  `);
  return result.rows.map((row) => row.table_name);
}

const owner = testUser();
const intruder = testUser();
let liveTables: string[] = [];

beforeAll(async () => {
  liveTables = await tablesWithUserIdColumn();
  await seedEveryUserOwnedTable(owner);
}, 60_000);

afterAll(async () => {
  await cleanupUser(owner);
  await cleanupUser(intruder);
});

describe("the enumeration itself", () => {
  it("agrees with the Drizzle schema about which tables are user-owned", () => {
    // Better Auth owns twelve tables of its own and migrates them separately.
    // Its `session`, `account` and OAuth tables key on `userId` in camelCase,
    // so they do not match the `user_id` predicate above and are correctly out
    // of scope here: they are covered by Better Auth's own foreign keys and by
    // the cascade in `deleteAccount`.
    expect([...liveTables].sort()).toEqual([...userOwnedTableNames()].sort());
  });

  it("found the tables at all, so nothing below can pass by finding none", () => {
    expect(liveTables.length).toBeGreaterThan(15);
  });
});

describe("row-level security is switched on and has a policy", () => {
  it.each(userOwnedTableNames())("%s", async (table) => {
    const state = await db.execute<{
      relrowsecurity: boolean;
      policies: number;
    }>(sql`
      select c.relrowsecurity,
             (select count(*)::int
                from pg_policies p
               where p.schemaname = 'public'
                 and p.tablename = ${table}) as policies
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relname = ${table}
    `);

    const [row] = state.rows;
    expect(row, `${table} is not in pg_class`).toBeDefined();
    // A table declared without `.enableRLS()` fails here, and the message says
    // which one, because a suite that reports "expected true, got false" over a
    // parameterized table name is a bug report nobody can act on.
    expect(
      row?.relrowsecurity,
      `${table} has row-level security disabled. Add .enableRLS() to its ` +
        "pgTable definition in src/db/schema.",
    ).toBe(true);
    expect(
      row?.policies ?? 0,
      `${table} has row-level security on and no policy, so every query as ` +
        "the runtime role returns nothing. Add ownerPolicy(...) to it.",
    ).toBeGreaterThan(0);
  });
});

describe("the scope actually holds", () => {
  it.each(userOwnedTableNames())("%s", async (table) => {
    const identifier = sql.identifier(table);

    // The seed is what stops this test passing vacuously. An unscoped read of
    // an empty table returns zero rows whether the policy works or not, so a
    // table with no seeded row proves nothing and is reported as a gap rather
    // than counted as a pass.
    const scoped = await withUser(owner.userId, (tx) =>
      tx.execute<{ count: number }>(
        sql`select count(*)::int as count from ${identifier} where user_id = ${owner.userId}`,
      ),
    );
    expect(
      scoped.rows[0]?.count ?? 0,
      `${table} has no seeded row, so the assertions below would pass on an ` +
        "empty table and prove nothing. Add a write for it to " +
        "seedEveryUserOwnedTable() in tests/helpers/seed.ts.",
    ).toBeGreaterThan(0);

    // No withUser: `app.user_id` is unset, `current_setting(..., true)` is
    // null, and the policy predicate is therefore never true. Silent but
    // empty, not a leak. This is the phase 0 exit criterion for tenancy.
    const unscoped = await db.execute<{ count: number }>(
      sql`select count(*)::int as count from ${identifier}`,
    );
    expect(
      unscoped.rows[0]?.count ?? -1,
      `${table} returned rows to a query with no scope set.`,
    ).toBe(0);

    // And the explicit form: another tenant naming the owner's id in the
    // predicate still sees nothing, which is the case a policy that filtered
    // on the wrong column would fail.
    const asIntruder = await withUser(intruder.userId, (tx) =>
      tx.execute<{ count: number }>(
        sql`select count(*)::int as count from ${identifier} where user_id = ${owner.userId}`,
      ),
    );
    expect(
      asIntruder.rows[0]?.count ?? -1,
      `${table} leaked rows to another tenant asking for them by user_id.`,
    ).toBe(0);
  });
});

describe("writing outside your own scope", () => {
  it("refuses a row owned by somebody else", async () => {
    // 42501 is insufficient_privilege, which is what a failed WITH CHECK
    // raises. Drizzle wraps the driver error, so the code sits one `cause`
    // down, which is what `pgCodeOf` walks.
    const error = await withUser(intruder.userId, async (tx) =>
      tx.insert(agentActivity).values({
        userId: owner.userId,
        toolName: "whoami",
        direction: "read",
        result: "ok",
      }),
    ).then(
      () => null,
      (thrown: unknown) => thrown,
    );

    expect(error).not.toBeNull();
    expect(pgCodeOf(error)).toBe("42501");
  });

  it("refuses to write a row with no scope set at all", async () => {
    const error = await db
      .insert(agentActivity)
      .values({
        userId: randomUUID(),
        toolName: "whoami",
        direction: "read",
        result: "ok",
      })
      .then(
        () => null,
        (thrown: unknown) => thrown,
      );

    expect(error).not.toBeNull();
    expect(pgCodeOf(error)).toBe("42501");
  });

  it("refuses an empty userId before it reaches the database", async () => {
    // `withUser` guards this itself, because an empty `app.user_id` reads as
    // null through the `nullif` in src/db/schema/_shared.ts: the transaction
    // would return zero rows and refuse every write, with no error anywhere.
    // Correct as a defence and useless as a diagnosis, so it is made loud.
    await expect(withUser("", async () => undefined)).rejects.toThrow(
      /empty userId/,
    );
  });
});
