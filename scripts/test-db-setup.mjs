// Creates and migrates the test database, so `npm test` never touches the
// database you develop against.
//
// Why this exists: Vitest loads the same .env the application does, and
// verify:oauth drives a real server, so before this both wrote into the
// developer's own data. A failed run left debris in rows somebody cared about,
// and a destructive test could not be written at all. Recorded as T6 in
// docs/06-open-questions.md.
//
// Idempotent, and safe to run against an instance that already has the database.
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { applyBootstrap, databaseNameOf, ensureDatabase, testUrls } from "./lib/db.mjs";

const { owner, app } = testUrls();
const name = databaseNameOf(owner);

// The guard that makes everything downstream safe to truncate. Deriving the name
// cannot produce this, so it only fires on a hand-written TEST_DATABASE_URL.
if (!name.endsWith("_test")) {
  console.error(
    `refusing to set up "${name}" as a test database: the name must end in _test, ` +
      "because the suite truncates every table in it before running.",
  );
  process.exit(1);
}

const password = new URL(app).password;
if (!password) {
  console.error("TEST_APP_DATABASE_URL carries no credential for the runtime role.");
  process.exit(1);
}

// Connects through the development database: an instance may not let you reach
// `postgres`, and by this point DATABASE_URL is known to work.
const state = await ensureDatabase(process.env.DATABASE_URL, name);
console.log(`test-db: database ${name} ${state}`);

await applyBootstrap(owner, password);
console.log("test-db: role cooking_app and grants are in place");

// Both migrators read DATABASE_URL, so pointing them at the test database is a
// matter of the environment they are spawned with rather than a second config.
const env = { ...process.env, DATABASE_URL: owner, APP_DATABASE_URL: app };

run("drizzle-kit", ["migrate"], env);
run("tsx", ["scripts/auth-migrate.ts"], env);

console.log("test-db: ready");

function run(binary, args, env) {
  const executable = fileURLToPath(new URL(`../node_modules/.bin/${binary}`, import.meta.url));
  const result = spawnSync(executable, args, { stdio: "inherit", env });
  if (result.status !== 0) {
    console.error(`test-db: ${binary} ${args.join(" ")} failed`);
    process.exit(result.status ?? 1);
  }
}
