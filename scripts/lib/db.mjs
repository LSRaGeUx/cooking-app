// Shared plumbing for the databases this project uses: the development one named
// by DATABASE_URL, and the siblings that sit beside it on the same instance.
// Same instance, because the isolation that matters is the database, not the
// server, and a second container would only be one more thing to start.
//
// Everything that decides what those databases are lives here, and only here.
// The setup script, the dev:test server and both Vitest setup files call it, so
// they cannot answer that question differently.
import { readFile } from "node:fs/promises";
import { Client } from "pg";

/**
 * The two databases beside the development one, and why each has to be its own.
 *
 * They are separate from each other, not only from development. The suite
 * truncates on the way in, and verify:oauth drives a long-lived server holding
 * sessions and OAuth consents: one database for both meant `npm test` deleting
 * the session a half-finished verification depended on, or blocking on the lock
 * that server held.
 */
const SIBLINGS = {
  test: {
    suffix: "_test",
    prefix: "TEST",
    setupCommand: "npm run db:setup:test",
    purpose: "the suite truncates every table in it before running",
  },
  verify: {
    suffix: "_verify",
    prefix: "VERIFY",
    setupCommand: "npm run db:setup:verify",
    purpose: "verify:oauth writes sign-ups, OAuth clients, recipes and plans into it",
  },
};

export const SIBLING_KINDS = Object.freeze(Object.keys(SIBLINGS));

function sibling(kind) {
  const found = SIBLINGS[kind];
  if (!found) {
    throw new Error(
      `unknown database kind "${kind}". Known kinds: ${SIBLING_KINDS.join(", ")}.`,
    );
  }
  return found;
}

/**
 * A sibling is the development database with a suffix appended, unless it is
 * named outright. Deriving it means the split needs no configuration to work,
 * and a derived name can never collide with the database it was derived from,
 * which is the property the guard below relies on.
 */
export function deriveSiblingUrl(url, kind) {
  return withDatabase(url, `${databaseNameOf(url)}${sibling(kind).suffix}`);
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

/** Owner and runtime URLs for one sibling, honouring an explicit override. */
export function siblingUrls(kind, env = process.env) {
  const { prefix } = sibling(kind);
  return {
    // Truthiness rather than `??`: an override that is present but empty, which
    // is what uncommenting the line in .env.example and leaving it blank
    // produces, is not a URL. Treating it as absent derives the usual name;
    // treating it as set would throw ERR_INVALID_URL from somewhere unrelated.
    owner:
      env[`${prefix}_DATABASE_URL`] ||
      deriveSiblingUrl(requireEnv(env, "DATABASE_URL"), kind),
    app:
      env[`${prefix}_APP_DATABASE_URL`] ||
      deriveSiblingUrl(requireEnv(env, "APP_DATABASE_URL"), kind),
  };
}

/**
 * Every rule that keeps a sibling from turning out to be a database somebody
 * cares about, in one place.
 *
 * Both URLs are checked, not just the owner one: the pool the application and
 * the tests query through is built from the app URL, so a guard that only reads
 * the owner URL can pass while every write lands in the developer's own data.
 * Both must also name the same database, or one gets emptied and the other
 * queried. The suffix is what separates the siblings from each other as well as
 * from development.
 *
 * Returns the shared database name.
 */
export function assertSiblingUrls(kind, { owner, app }, env = process.env) {
  const { suffix, prefix, purpose } = sibling(kind);
  const names = {
    [`${prefix}_DATABASE_URL`]: databaseNameOf(owner),
    [`${prefix}_APP_DATABASE_URL`]: databaseNameOf(app),
  };

  for (const [variable, name] of Object.entries(names)) {
    if (!name.endsWith(suffix)) {
      throw new Error(
        `refusing to use "${name}" as the ${kind} database: the name must end ` +
          `in ${suffix}, because ${purpose}. Set ${variable} to a database of ` +
          "its own, or leave it unset and let the name be derived.",
      );
    }
  }

  const [ownerName, appName] = Object.values(names);
  if (ownerName !== appName) {
    throw new Error(
      `${prefix}_DATABASE_URL names "${ownerName}" and ${prefix}_APP_DATABASE_URL ` +
        `names "${appName}". They are the owner and runtime roles of one ` +
        "database, so they must name the same one: otherwise one database is " +
        "written to and another read from.",
    );
  }

  for (const [variable, target] of [["DATABASE_URL", owner], ["APP_DATABASE_URL", app]]) {
    const development = env[variable];
    if (development && targetOf(development) === targetOf(target)) {
      throw new Error(
        `${prefix}_${variable} points at the same database as ${variable}. ` +
          `The ${kind} database is disposable by construction, so it refuses to ` +
          "be anything but a database of its own.",
      );
    }
  }

  return ownerName;
}

/** The command that creates and migrates one sibling, for an error message. */
export function setupCommandFor(kind) {
  return sibling(kind).setupCommand;
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
 * even when the sibling was pointed somewhere else: a raw DATABASE_URL creates
 * the database in the wrong cluster, or in no cluster at all when it is unset
 * because the overrides were given instead.
 */
export function adminUrlFor(url, kind, fallback = "postgres") {
  const name = databaseNameOf(url);
  const { suffix } = sibling(kind);
  const development = name.endsWith(suffix) ? name.slice(0, -suffix.length) : "";
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
 * Roles are cluster-wide, so a later call in another database adds only the
 * grants. It does not, however, leave the role alone: bootstrap.sql ALTERs the
 * password unconditionally, so whatever this is handed becomes the password for
 * every database on the instance. Pass the one the application connects with
 * and nothing else, or setting up a sibling locks the development one out with
 * a bare 28P01.
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

/** Connects, turning the two failures a developer actually hits into advice. */
export async function connectChecked(ownerUrl, name, setupCommand) {
  const client = new Client({ connectionString: ownerUrl });
  try {
    await client.connect();
  } catch (error) {
    // 3D000 is the case every existing checkout hits the first time a new
    // sibling is introduced, so it is the one that must not surface as a bare
    // Postgres error.
    if (codeOf(error) === "3D000") {
      throw new Error(
        `the database "${name}" does not exist. Run \`${setupCommand}\`.`,
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`cannot connect to the database "${name}": ${message}`);
  }
  return client;
}

/**
 * Nothing re-migrates a sibling when a migration is added, and the developer who
 * adds one runs `npm run db:migrate`, which migrates the development database.
 * Without this the failure is a raw `column "..." does not exist`, somewhere in
 * the middle of a run, with no hint about which command fixes it.
 */
export async function assertMigrationsApplied(client, name, setupCommand) {
  const journal = JSON.parse(
    await readFile(
      new URL("../../drizzle/meta/_journal.json", import.meta.url),
      "utf8",
    ),
  );

  const applied = await client
    .query("select count(*)::int as applied from drizzle.__drizzle_migrations")
    // 42P01: no ledger at all, so nothing has ever been migrated here.
    .then((result) => result.rows[0]?.applied ?? 0)
    .catch((error) => {
      if (codeOf(error) === "42P01") return 0;
      throw error;
    });

  if (applied >= journal.entries.length) return;

  throw new Error(
    `the database "${name}" is ${journal.entries.length - applied} migration(s) ` +
      `behind the ones on disk. Run \`${setupCommand}\`.`,
  );
}

/** Connect, check the schema, disconnect. For a caller with nothing else to do. */
export async function assertDatabaseReady(ownerUrl, name, setupCommand) {
  const client = await connectChecked(ownerUrl, name, setupCommand);
  try {
    await assertMigrationsApplied(client, name, setupCommand);
  } finally {
    await client.end();
  }
}

/**
 * Empties every table in `public`.
 *
 * Schema-qualified, because a bare name resolves through search_path: with a
 * schema named after the connecting role in front of `public`, an unqualified
 * TRUNCATE empties that one and leaves the tables the caller reads untouched,
 * silently. Filtered by privilege too, so one table owned by somebody else
 * cannot abort the whole statement. Drizzle keeps its migration ledger in its
 * own schema, so `public` is exactly the right scope.
 */
export async function truncatePublicTables(ownerUrl, name, setupCommand) {
  const client = await connectChecked(ownerUrl, name, setupCommand);
  try {
    await assertMigrationsApplied(client, name, setupCommand);

    const { rows } = await client.query(
      `select format('%I.%I', schemaname, tablename) as table
         from pg_tables
        where schemaname = 'public'
          and has_table_privilege(format('%I.%I', schemaname, tablename), 'TRUNCATE')`,
    );
    if (rows.length === 0) {
      throw new Error(
        `the database "${name}" holds no table this connection may truncate. ` +
          `Run \`${setupCommand}\`.`,
      );
    }

    // Without a timeout, a TRUNCATE behind somebody else's open transaction
    // waits on ACCESS EXCLUSIVE forever, and nothing here bounds it.
    await client.query("set lock_timeout = '5s'");
    try {
      await client.query(
        `truncate table ${rows.map((row) => row.table).join(", ")} restart identity cascade`,
      );
    } catch (error) {
      if (codeOf(error) === "55P03") {
        throw new Error(
          `cannot empty the database "${name}": another connection is holding a ` +
            "lock on it. Stop whatever is connected to it and try again.",
        );
      }
      throw error;
    }
  } finally {
    await client.end();
  }
}

function codeOf(error) {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}
