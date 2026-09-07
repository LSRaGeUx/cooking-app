import { Pool } from "pg";

/**
 * A connection as the table owner, which row-level security does not apply to.
 *
 * Every other query in this suite runs as `cooking_app`, the `NOBYPASSRLS`
 * runtime role, and that is the point of the suite. It is also what makes one
 * assertion impossible to write: "this user's rows are really gone" cannot be
 * checked through a connection whose policies hide another tenant's rows
 * anyway, because a row left behind and a row hidden look identical.
 *
 * Postgres exempts a table owner from its own policies, so this connection sees
 * everything. It exists for exactly that one question, in
 * `tests/services/account.test.ts`. Do not reach for it to set up fixtures: a
 * fixture written as the owner is a fixture that proves nothing about whether
 * the application could have written it.
 *
 * The URL is read off `DATABASE_URL`, which `tests/setup/test-database.ts` has
 * already rewritten to the test database through `siblingUrls("test")` before
 * any test file's module graph loads. Calling `siblingUrls("test")` again from
 * here would append the suffix a second time and ask for `cooking_test_test`,
 * which is how deriving a name twice goes wrong.
 */
let pool: Pool | undefined;

function ownerPool(): Pool {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is unset. tests/setup/test-database.ts sets it as a " +
        "Vitest setupFile, so this helper is being used outside the suite.",
    );
  }

  pool ??= new Pool({
    connectionString,
    max: 2,
    idleTimeoutMillis: 5_000,
  });
  return pool;
}

/** Counts the rows one user owns in `table`, seeing past every policy. */
export async function ownerRowCount(
  table: string,
  userId: string,
): Promise<number> {
  // The name is interpolated rather than bound, because a table name cannot be
  // a parameter. It comes from `information_schema` or from the Drizzle schema,
  // so it is not user input, and the guard is here so that stays true by
  // construction rather than by everyone remembering.
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) {
    throw new Error(`Refusing to interpolate ${table} as a table name.`);
  }

  const result = await ownerPool().query<{ count: string }>(
    `select count(*) as count from "${table}" where user_id = $1`,
    [userId],
  );
  return Number(result.rows[0]?.count ?? "-1");
}

/** Closes the pool, so the runner is not held open by an idle connection. */
export async function closeOwnerPool(): Promise<void> {
  const open = pool;
  pool = undefined;
  await open?.end();
}
