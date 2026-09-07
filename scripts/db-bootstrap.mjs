// Creates the least-privileged runtime role and its grants. Idempotent.
// Runs as the owner role (DATABASE_URL) before any migration.
//
// The runtime role credential is taken from APP_DATABASE_URL rather than written
// into the SQL, so it stays out of version control and cannot drift from what the
// app actually connects with.
import "dotenv/config";
import {
  applyBootstrap,
  connectionFailure,
  databaseNameOf,
  passwordOf,
  redactUrl,
} from "./lib/db.mjs";

const ownerUrl = process.env.DATABASE_URL;
const appUrl = process.env.APP_DATABASE_URL;

if (!ownerUrl || !appUrl) {
  console.error(
    "DATABASE_URL and APP_DATABASE_URL must both be set. Copy .env.example to .env.",
  );
  process.exit(1);
}

/**
 * Both URLs are parsed before anything connects, and checked against the
 * credentials compose was given.
 *
 * This is the first thing that runs in the migrator container, and the URLs it
 * reads were assembled by string substitution in compose.yaml, which has no way
 * to percent-encode a value. A POSTGRES_PASSWORD holding `@` moves the userinfo
 * boundary and the host becomes part of the password; one holding `/` ends the
 * path and the database name changes; `#` truncates it at a fragment. Every one
 * of those parses cleanly and connects, or fails to, somewhere else entirely,
 * and what the operator sees is an authentication error that sends them to
 * check a password that was right all along.
 *
 * So the shape is asserted rather than trusted, and only where there is
 * something to compare against: POSTGRES_DB and POSTGRES_USER exist in the
 * container and not in a from-source checkout.
 */
function assertUrlShape(variable, url, expected) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return [`${variable} is not a URL.`];
  }

  const problems = [];
  const database = databaseNameOf(url);

  if (expected.database && database !== expected.database) {
    problems.push(
      `${variable} points at the database "${database}", but POSTGRES_DB is ` +
        `"${expected.database}".`,
    );
  }
  if (expected.user && parsed.username !== expected.user) {
    problems.push(
      `${variable} connects as "${parsed.username}", but POSTGRES_USER is ` +
        `"${expected.user}".`,
    );
  }
  return problems;
}

const expectedDatabase = process.env.POSTGRES_DB;
const problems = [
  ...assertUrlShape("DATABASE_URL", ownerUrl, {
    database: expectedDatabase,
    user: process.env.POSTGRES_USER,
  }),
  ...assertUrlShape("APP_DATABASE_URL", appUrl, {
    database: expectedDatabase,
    // The runtime role's name is fixed by bootstrap.sql, not configurable.
    user: expectedDatabase ? "cooking_app" : undefined,
  }),
];

if (databaseNameOf(ownerUrl) !== databaseNameOf(appUrl)) {
  problems.push(
    `DATABASE_URL names the database "${databaseNameOf(ownerUrl)}" and ` +
      `APP_DATABASE_URL names "${databaseNameOf(appUrl)}". They are the owner ` +
      "and runtime roles of one database, so they must name the same one.",
  );
}

if (problems.length > 0) {
  console.error(
    "bootstrap: refusing to run, because the connection URLs are not what the " +
      "configuration says they should be:\n" +
      problems.map((problem) => `  - ${problem}`).join("\n") +
      "\n\nThe usual cause is a password that is not URL-safe. compose.yaml " +
      "builds both URLs out of POSTGRES_PASSWORD and APP_DB_PASSWORD by " +
      "substitution, and a value holding /, @, #, % or : parses as something " +
      "else. Generate both with `openssl rand -hex 24`, which cannot, or mount " +
      "the whole URL as a file: see the DATABASE_URL_FILE block in " +
      ".env.example.\n" +
      `As parsed: ${redactUrl(ownerUrl)} and ${redactUrl(appUrl)}`,
  );
  process.exit(1);
}

const pw = passwordOf(appUrl);
if (!pw) {
  console.error("APP_DATABASE_URL carries no credential for the runtime role.");
  process.exit(1);
}

try {
  await applyBootstrap(ownerUrl, pw);
} catch (error) {
  // The same redacted message `npm run db:setup` gives for the same failure.
  // Without it a wrong owner password is a bare 28P01 stack trace.
  console.error(connectionFailure(ownerUrl, "bootstrap", error).message);
  process.exit(1);
}

console.log("bootstrap: role cooking_app and grants are in place");
