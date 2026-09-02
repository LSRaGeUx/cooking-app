import { assertSiblingUrls, siblingUrls } from "../../scripts/lib/db.mjs";

/**
 * Points every test at the test database, before any test file imports
 * `src/db/client.ts` and opens its pool.
 *
 * This runs as a Vitest `setupFile`, which executes ahead of the module graph of
 * each test file. That ordering is the whole mechanism: `src/db/client.ts` reads
 * `APP_DATABASE_URL` once at import and builds a pool from it, so rewriting the
 * variable afterwards would change nothing.
 *
 * Both the names and the guard come from scripts/lib/db.mjs, which the setup
 * script and the globalSetup also call. Deriving them twice is how the truncated
 * database and the queried one came to be able to differ.
 */
const target = siblingUrls("test");
assertSiblingUrls("test", target);

process.env.DATABASE_URL = target.owner;
process.env.APP_DATABASE_URL = target.app;
