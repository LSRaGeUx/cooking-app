import "dotenv/config";
import { Client } from "pg";
import { databaseNameOf, testUrls } from "../../scripts/lib/db.mjs";

/**
 * Empties the test database once, before the run.
 *
 * Each test already cleans up the user it created, which is enough while
 * everything passes. It is not enough after a failure: the run stops mid-way and
 * leaves rows behind, and the next run inherits them. Starting from empty makes
 * a failing suite reproducible instead of path-dependent.
 *
 * Tables are read from the catalogue rather than listed, so a new migration is
 * covered without anybody remembering to add it here. Drizzle keeps its
 * migration ledger in its own schema, so `public` is exactly the right scope.
 */
export async function setup(): Promise<void> {
  const { owner } = testUrls();
  const name = databaseNameOf(owner);

  if (!name.endsWith("_test")) {
    throw new Error(
      `refusing to truncate "${name}": a test database must be named with a ` +
        "_test suffix, and this one is not.",
    );
  }

  const client = new Client({ connectionString: owner });
  await client.connect();
  try {
    const { rows } = await client.query<{ table: string }>(
      `select quote_ident(tablename) as table
         from pg_tables
        where schemaname = 'public'`,
    );
    if (rows.length === 0) {
      throw new Error(
        `the test database "${name}" holds no tables. Run \`npm run db:setup\`.`,
      );
    }
    await client.query(
      `truncate table ${rows.map((row) => row.table).join(", ")} restart identity cascade`,
    );
  } finally {
    await client.end();
  }
}
