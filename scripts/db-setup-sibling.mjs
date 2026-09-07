// Creates and migrates one of the databases that sit beside the development one,
// so nothing automated ever writes into the database you develop against.
//
//   node scripts/db-setup-sibling.mjs test     # what `npm test` truncates
//   node scripts/db-setup-sibling.mjs verify   # what `npm run dev:test` serves
//
// Why they are two and not one: the suite truncates on the way in, and
// verify:oauth drives a long-lived server holding sessions and OAuth consents.
// Sharing one database meant `npm test` deleting the session a half-finished
// verification depended on, or blocking on a lock that server held. Recorded as
// T6 in docs/06-open-questions.md.
//
// Idempotent, and safe to run against an instance that already has the database.
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  SIBLING_KINDS,
  adminUrlFor,
  applyBootstrap,
  assertSiblingUrls,
  connectionFailure,
  ensureDatabase,
  passwordOf,
  siblingUrls,
} from "./lib/db.mjs";

const kind = process.argv[2];
if (!SIBLING_KINDS.includes(kind)) {
  console.error(
    `usage: node scripts/db-setup-sibling.mjs <${SIBLING_KINDS.join("|")}>`,
  );
  process.exit(1);
}

const urls = siblingUrls(kind);

// The guard that makes everything downstream safe, shared with the Vitest setup
// and the dev:test server so none of them can disagree about what this is.
let name;
try {
  name = assertSiblingUrls(kind, urls);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

// The runtime role is cluster-wide: one role, one password, whichever database
// it is reached through. bootstrap.sql re-applies that password on every call,
// so it has to come from the application's own URL. Taking it from the sibling's
// URL is how `npm run db:setup` used to end by locking development out.
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
    `the ${kind} runtime URL and APP_DATABASE_URL carry different passwords for ` +
      "cooking_app. The role is cluster-wide, so it has one password: give both " +
      "URLs the same one, or setting this up locks the development database out.",
  );
  process.exit(1);
}

// Connects through the development database beside the target, derived from the
// target itself: the same instance and the same credentials, which is not what
// a raw DATABASE_URL gives when the sibling was pointed elsewhere.
const adminUrl = adminUrlFor(urls.owner, kind);
let state;
try {
  state = await ensureDatabase(adminUrl, name);
} catch (error) {
  console.error(connectionFailure(adminUrl, `${kind}-db`, error).message);
  process.exit(1);
}
console.log(`${kind}-db: database ${name} ${state}`);

// The same wrapping as the line above, and as scripts/db-bootstrap.mjs. This
// call used to be bare, so the wrong owner password produced advice on one line
// and a raw 28P01 stack trace on the next.
try {
  await applyBootstrap(urls.owner, password);
} catch (error) {
  console.error(connectionFailure(urls.owner, `${kind}-db`, error).message);
  process.exit(1);
}
console.log(`${kind}-db: role cooking_app and grants are in place`);

// Both migrators read DATABASE_URL, so pointing them at the sibling is a matter
// of the environment they are spawned with rather than a second config.
const env = {
  ...process.env,
  DATABASE_URL: urls.owner,
  APP_DATABASE_URL: urls.app,
};

run("drizzle-kit", ["migrate"], env);
run("tsx", ["scripts/auth-migrate.ts"], env);

console.log(`${kind}-db: ready`);

function run(binary, args, env) {
  const executable = fileURLToPath(
    new URL(`../node_modules/.bin/${binary}`, import.meta.url),
  );
  const result = spawnSync(executable, args, { stdio: "inherit", env });
  if (result.status !== 0) {
    console.error(`${kind}-db: ${binary} ${args.join(" ")} failed`);
    process.exit(result.status ?? 1);
  }
}
