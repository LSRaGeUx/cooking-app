// Shared plumbing for the two databases this project uses: the development one
// named by DATABASE_URL, and the test one beside it. Both live on the same
// Postgres instance, because the isolation that matters is the database, not
// the server, and a second container would only be one more thing to start.
import { readFile } from "node:fs/promises";
import { Client } from "pg";

/**
 * The test database is the development one with `_test` appended, unless it is
 * named outright. Deriving it means the split needs no configuration to work,
 * and the derived name can never collide with the database it was derived from,
 * which is the property the guard in tests/setup relies on.
 */
export function deriveTestUrl(url) {
  const parsed = new URL(url);
  parsed.pathname = `/${databaseNameOf(url)}_test`;
  return parsed.toString();
}

export function databaseNameOf(url) {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
}

/** Both test URLs, honouring an explicit override for either. */
export function testUrls(env = process.env) {
  const owner = env.TEST_DATABASE_URL ?? deriveTestUrl(requireEnv(env, "DATABASE_URL"));
  const app =
    env.TEST_APP_DATABASE_URL ?? deriveTestUrl(requireEnv(env, "APP_DATABASE_URL"));
  return { owner, app };
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
 * `ownerUrl` points at. Roles are cluster-wide, so the second call only adds the
 * grants; the role itself already exists. Idempotent either way.
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
