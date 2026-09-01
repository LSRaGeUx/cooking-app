import { deriveTestUrl } from "../../scripts/lib/db.mjs";

/**
 * Points every test at the test database, before any test file imports
 * `src/db/client.ts` and opens its pool.
 *
 * This runs as a Vitest `setupFile`, which executes ahead of the module graph of
 * each test file. That ordering is the whole mechanism: `src/db/client.ts` reads
 * `APP_DATABASE_URL` once at import and builds a pool from it, so rewriting the
 * variable afterwards would change nothing.
 *
 * The name is derived rather than configured, so the split works on a clone with
 * no extra setup, and a derived name can never equal the database it came from.
 */
function testUrl(name: "DATABASE_URL" | "APP_DATABASE_URL"): string {
  const explicit = process.env[`TEST_${name}`];
  if (explicit) return explicit;

  const development = process.env[name];
  if (!development) {
    throw new Error(
      `${name} must be set before the test suite can derive its test database. ` +
        "Copy .env.example to .env.",
    );
  }
  return deriveTestUrl(development);
}

for (const name of ["DATABASE_URL", "APP_DATABASE_URL"] as const) {
  const target = testUrl(name);

  if (target === process.env[name]) {
    throw new Error(
      `TEST_${name} points at the development database. The suite truncates ` +
        "every table it can see, so it refuses to run against anything but a " +
        "database of its own.",
    );
  }

  process.env[name] = target;
}
