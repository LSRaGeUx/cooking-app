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
import {
  adminUrlFor,
  applyBootstrap,
  assertTestUrls,
  ensureDatabase,
  passwordOf,
  redactUrl,
  testUrls,
} from "./lib/db.mjs";

const urls = testUrls();

// The guard that makes everything downstream safe to truncate, shared with the
// Vitest setup so the two cannot disagree about what the test database is.
let name;
try {
  name = assertTestUrls(urls);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

// The runtime role is cluster-wide: one role, one password, whichever database
// it is reached through. bootstrap.sql re-applies that password on every call,
// so it has to come from the application's own URL. Taking it from the test URL
// is how `npm run db:setup` used to end by locking the development database out.
const appUrl = process.env.APP_DATABASE_URL;
if (!appUrl) {
  console.error("APP_DATABASE_URL must be set. Copy .env.example to .env.");
  process.exit(1);
}

const password = passwordOf(appUrl);
if (!password) {
  console.error("APP_DATABASE_URL carries no credential for the runtime role.");
  process.exit(1);
}

if (passwordOf(urls.app) !== password) {
  console.error(
    "TEST_APP_DATABASE_URL and APP_DATABASE_URL carry different passwords for " +
      "cooking_app. The role is cluster-wide, so it has one password: give both " +
      "URLs the same one, or setting up the test database locks the development " +
      "one out.",
  );
  process.exit(1);
}

// Connects through the development database beside the target, derived from the
// target itself: the same instance and the same credentials, which is not what
// a raw DATABASE_URL gives when the test database was pointed elsewhere.
const adminUrl = adminUrlFor(urls.owner);
let state;
try {
  state = await ensureDatabase(adminUrl, name);
} catch (error) {
  console.error(
    `test-db: cannot reach the instance that should hold ${name} via ` +
      `${redactUrl(adminUrl)}: ${error.message}`,
  );
  process.exit(1);
}
console.log(`test-db: database ${name} ${state}`);

await applyBootstrap(urls.owner, password);
console.log("test-db: role cooking_app and grants are in place");

// Both migrators read DATABASE_URL, so pointing them at the test database is a
// matter of the environment they are spawned with rather than a second config.
const env = { ...process.env, DATABASE_URL: urls.owner, APP_DATABASE_URL: urls.app };

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
