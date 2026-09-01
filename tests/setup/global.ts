import "dotenv/config";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import type { TestProject } from "vitest/node";
import { assertTestUrls, testUrls } from "../../scripts/lib/db.mjs";

/**
 * Empties the test database before the run, and before every rerun.
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
export async function setup(project: TestProject): Promise<void> {
  await truncateTestDatabase();

  // Vitest runs globalSetup once per process, not once per run, so in watch mode
  // the paragraph above would hold for the first pass and for no other: a save
  // after a failure reruns against the debris. This hook is what makes the
  // promise true for `vitest` and not only for `vitest run`.
  project.onTestsRerun(truncateTestDatabase);
}

async function truncateTestDatabase(): Promise<void> {
  const urls = testUrls();
  const name = assertTestUrls(urls);

  const client = new Client({ connectionString: urls.owner });
  try {
    await client.connect();
  } catch (error) {
    throw new Error(describeConnectionFailure(name, error));
  }

  try {
    await assertSchemaIsCurrent(client, name);

    // Schema-qualified, because a bare name resolves through search_path: with a
    // schema named after the connecting role in front of `public`, an unqualified
    // TRUNCATE empties that one and leaves the tables the suite reads untouched,
    // silently. Filtered by privilege too, so one table owned by somebody else
    // cannot abort the whole statement.
    const { rows } = await client.query<{ table: string }>(
      `select format('%I.%I', schemaname, tablename) as table
         from pg_tables
        where schemaname = 'public'
          and has_table_privilege(format('%I.%I', schemaname, tablename), 'TRUNCATE')`,
    );
    if (rows.length === 0) {
      throw new Error(
        `the test database "${name}" holds no table this connection may ` +
          "truncate. Run `npm run db:setup:test`.",
      );
    }

    // `npm run dev:test` serves on this same database. Without a timeout, a
    // TRUNCATE behind one of its open transactions waits on ACCESS EXCLUSIVE
    // forever, and nothing in Vitest bounds globalSetup.
    await client.query("set lock_timeout = '5s'");
    try {
      await client.query(
        `truncate table ${rows.map((row) => row.table).join(", ")} restart identity cascade`,
      );
    } catch (error) {
      if (codeOf(error) === "55P03") {
        throw new Error(
          `cannot empty the test database "${name}": another connection is ` +
            "holding a lock on it. `npm run dev:test` serves on this same " +
            "database, so stop it before running the suite.",
        );
      }
      throw error;
    }
  } finally {
    await client.end();
  }
}

/**
 * Nothing re-migrates the test database when a migration is added, and the
 * developer who adds one runs `npm run db:migrate`, which migrates the other
 * one. Without this the run fails somewhere in the middle with a raw
 * `column "..." does not exist` and no hint about which command fixes it.
 */
async function assertSchemaIsCurrent(client: Client, name: string): Promise<void> {
  const journal = JSON.parse(
    await readFile(
      new URL("../../drizzle/meta/_journal.json", import.meta.url),
      "utf8",
    ),
  ) as { entries: readonly unknown[] };

  const applied = await client
    .query<{ applied: number }>(
      "select count(*)::int as applied from drizzle.__drizzle_migrations",
    )
    // 42P01: no ledger at all, so nothing has ever been migrated here.
    .then((result) => result.rows[0]?.applied ?? 0)
    .catch((error: unknown) => {
      if (codeOf(error) === "42P01") return 0;
      throw error;
    });

  if (applied >= journal.entries.length) return;

  throw new Error(
    `the test database "${name}" is ${journal.entries.length - applied} ` +
      "migration(s) behind the ones on disk. Run `npm run db:setup:test`.",
  );
}

function describeConnectionFailure(name: string, error: unknown): string {
  // 3D000 is the case every existing checkout hits on the first run after this
  // landed, so it is the one that must not surface as a bare Postgres error.
  if (codeOf(error) === "3D000") {
    return `the test database "${name}" does not exist. Run \`npm run db:setup:test\`.`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `cannot connect to the test database "${name}": ${message}`;
}

function codeOf(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : undefined;
}
