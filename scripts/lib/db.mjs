// Shared plumbing for the two databases this project uses: the development one
// named by DATABASE_URL, and the test one beside it. Both live on the same
// Postgres instance, because the isolation that matters is the database, not
// the server, and a second container would only be one more thing to start.
//
// Everything that decides what "the test database" is lives here, and only
// here. The setup script, the Vitest globalSetup and the Vitest setupFile all
// call it, so they cannot answer that question differently.
import { readFile } from "node:fs/promises";
import { Client } from "pg";

const TEST_SUFFIX = "_test";

/**
 * The test database is the development one with `_test` appended, unless it is
 * named outright. Deriving it means the split needs no configuration to work,
 * and the derived name can never collide with the database it was derived from,
 * which is the property the guard below relies on.
 */
export function deriveTestUrl(url) {
  return withDatabase(url, `${databaseNameOf(url)}${TEST_SUFFIX}`);
}

export function databaseNameOf(url) {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
}

/** The same connection URL, pointed at another database on the same instance. */
function withDatabase(url, name) {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

/**
 * The password node-postgres will actually connect with.
 *
 * `new URL(u).password` is the percent-ENCODED form and pg-connection-string
 * runs `decodeURIComponent` over it, so reading the property straight off the
 * parse hands the bootstrap a different string from the one the application
 * uses. Any credential holding a `+` or a `/`, which is every other
 * `openssl rand -base64` value, takes that path.
 */
export function passwordOf(url) {
  return decodeURIComponent(new URL(url).password);
}

/** Host, port and database, for comparing two URLs by what they point at. */
function targetOf(url) {
  const parsed = new URL(url);
  return `${parsed.hostname}:${parsed.port || "5432"}/${databaseNameOf(url)}`;
}

/** A URL with the credential removed, safe to print in an error. */
export function redactUrl(url) {
  const parsed = new URL(url);
  if (parsed.password) parsed.password = "***";
  return parsed.toString();
}

/** Both test URLs, honouring an explicit override for either. */
export function testUrls(env = process.env) {
  return {
    // Truthiness rather than `??`: an override that is present but empty, which
    // is what uncommenting the line in .env.example and leaving it blank
    // produces, is not a URL. Treating it as absent derives the usual name;
    // treating it as set would throw ERR_INVALID_URL from somewhere unrelated.
    owner: env.TEST_DATABASE_URL || deriveTestUrl(requireEnv(env, "DATABASE_URL")),
    app:
      env.TEST_APP_DATABASE_URL ||
      deriveTestUrl(requireEnv(env, "APP_DATABASE_URL")),
  };
}

/**
 * Every rule that makes the test database safe to truncate, in one place.
 *
 * Both URLs are checked, not just the owner one: the pool the tests actually
 * query through is built from the app URL, so a guard that only reads the owner
 * URL can pass while every insert lands in the developer's own data. Both must
 * also name the same database, or the run truncates one and queries another.
 *
 * Returns the shared database name.
 */
export function assertTestUrls({ owner, app }, env = process.env) {
  const names = { TEST_DATABASE_URL: databaseNameOf(owner), TEST_APP_DATABASE_URL: databaseNameOf(app) };

  for (const [variable, name] of Object.entries(names)) {
    if (!name.endsWith(TEST_SUFFIX)) {
      throw new Error(
        `refusing to use "${name}" as a test database: the name must end in ` +
          `${TEST_SUFFIX}, because the suite truncates every table in it before ` +
          `running. Set ${variable} to a database of its own, or leave it unset ` +
          "and let the name be derived.",
      );
    }
  }

  if (names.TEST_DATABASE_URL !== names.TEST_APP_DATABASE_URL) {
    throw new Error(
      `TEST_DATABASE_URL names "${names.TEST_DATABASE_URL}" and ` +
        `TEST_APP_DATABASE_URL names "${names.TEST_APP_DATABASE_URL}". They are ` +
        "the owner and runtime roles of one database, so they must name the same " +
        "one: otherwise the suite empties one database and queries another.",
    );
  }

  for (const [variable, target] of [["DATABASE_URL", owner], ["APP_DATABASE_URL", app]]) {
    const development = env[variable];
    if (development && targetOf(development) === targetOf(target)) {
      throw new Error(
        `TEST_${variable} points at the same database as ${variable}. The suite ` +
          "truncates every table it can see, so it refuses to run against " +
          "anything but a database of its own.",
      );
    }
  }

  return names.TEST_DATABASE_URL;
}

function requireEnv(env, name) {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} must be set. Copy .env.example to .env.`);
  }
  return value;
}

function quoteIdentifier(name) {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * CREATE DATABASE has to be issued from a connection to some other database on
 * the same instance. Deriving that connection from the target URL rather than
 * reading DATABASE_URL keeps it on the same server, with the same credentials,
 * even when the test database was pointed somewhere else: a raw DATABASE_URL
 * creates the database in the wrong cluster, or in no cluster at all when it is
 * unset because both TEST_* overrides were given instead.
 */
export function adminUrlFor(url, fallback = "postgres") {
  const name = databaseNameOf(url);
  const development = name.endsWith(TEST_SUFFIX)
    ? name.slice(0, -TEST_SUFFIX.length)
    : "";
  return withDatabase(url, development || fallback);
}

/**
 * CREATE DATABASE cannot run inside a transaction and cannot be parameterised,
 * hence the existence check and the quoted identifier. Connects through the
 * development database rather than `postgres`, which a managed instance may not
 * let you reach.
 */
export async function ensureDatabase(adminUrl, name) {
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const existing = await client.query(
      "select 1 from pg_database where datname = $1",
      [name],
    );
    if (existing.rowCount === 0) {
      await client.query(`create database ${quoteIdentifier(name)}`);
      return "created";
    }
    return "present";
  } finally {
    await client.end();
  }
}

/**
 * Creates the least-privileged runtime role and its grants in whichever database
 * `ownerUrl` points at. Idempotent.
 *
 * Roles are cluster-wide, so a second call in a second database adds only the
 * grants. It does not, however, leave the role alone: bootstrap.sql ALTERs the
 * password unconditionally, so whatever this is handed becomes the password for
 * every database on the instance. Pass the one the application connects with
 * and nothing else, or setting up the test database locks the development one
 * out with a bare 28P01.
 */
export async function applyBootstrap(ownerUrl, appPassword) {
  const sql = await readFile(
    new URL("../../src/db/bootstrap.sql", import.meta.url),
    "utf8",
  );
  const client = new Client({ connectionString: ownerUrl });
  await client.connect();
  try {
    // Bound, not interpolated, and the SQL quotes it with format(%L).
    await client.query(
      "select set_config('bootstrap.app_password', $1, false)",
      [appPassword],
    );
    await client.query(sql);
  } finally {
    await client.end();
  }
}
