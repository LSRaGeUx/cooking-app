import "dotenv/config";
import type { TestProject } from "vitest/node";
import {
  assertSiblingUrls,
  setupCommandFor,
  siblingUrls,
  truncatePublicTables,
} from "../../scripts/lib/db.mjs";

/**
 * Empties the test database before the run, and before every rerun.
 *
 * Each test already cleans up the user it created, which is enough while
 * everything passes. It is not enough after a failure: the run stops mid-way and
 * leaves rows behind, and the next run inherits them. Starting from empty makes
 * a failing suite reproducible instead of path-dependent.
 *
 * Nothing else connects to this database. `npm run dev:test` serves on the
 * verification one, precisely so that emptying this one on the way in cannot
 * take a running server's session with it.
 */
export async function setup(project: TestProject): Promise<void> {
  await emptyTestDatabase();

  // Vitest runs globalSetup once per process, not once per run, so in watch mode
  // the paragraph above would hold for the first pass and for no other: a save
  // after a failure reruns against the debris. This hook is what makes the
  // promise true for `vitest` and not only for `vitest run`.
  project.onTestsRerun(emptyTestDatabase);
}

async function emptyTestDatabase(): Promise<void> {
  const urls = siblingUrls("test");
  const name = assertSiblingUrls("test", urls);
  await truncatePublicTables(urls.owner, name, setupCommandFor("test"));
}
