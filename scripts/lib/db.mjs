// Shared plumbing for the databases this project uses: the development one named
// by DATABASE_URL, and the siblings that sit beside it on the same instance.
// Same instance, because the isolation that matters is the database, not the
// server, and a second container would only be one more thing to start.
//
// Everything that decides what those databases are lives here, and only here.
// The setup script, the dev:test server and both Vitest setup files call it, so
// they cannot answer that question differently.
import { createHash } from "node:crypto";
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
    purpose:
      "verify:oauth writes sign-ups, OAuth clients, recipes and plans into it",
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

/**
 * The one message every bootstrap path prints when a connection fails.
 *
 * `applyBootstrap` used to be called bare while `ensureDatabase` beside it had
 * this wrapped, so the same wrong owner password produced friendly advice on
 * one line of a script and a bare `28P01` stack trace on the next. Both go
 * through here now, and the URL is always redacted: it is about to be printed,
 * and it carries a credential.
 *
 * `what` names the step, so the reader knows which of several connections it
 * was.
 */
export function connectionFailure(url, what, error) {
  const message = error instanceof Error ? error.message : String(error);
  const advice = {
    // The two a developer actually hits, and the two that read as something
    // else entirely without a sentence attached.
    "28P01":
      " The password in that URL is not the one the role has. bootstrap.sql " +
      "re-applies the runtime role's password on every call, and the role is " +
      "cluster-wide, so a sibling set up with a different APP_DATABASE_URL is " +
      "the usual cause.",
    "3D000": " That database does not exist yet.",
    ECONNREFUSED: " Nothing is listening there. Try `npm run db:up`.",
  }[codeOf(error) ?? ""];

  return new Error(
    `${what}: cannot reach ${redactUrl(url)}: ${message}${advice ?? ""}`,
  );
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

  for (const [variable, target] of [
    ["DATABASE_URL", owner],
    ["APP_DATABASE_URL", app],
  ]) {
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
  const development = name.endsWith(suffix)
    ? name.slice(0, -suffix.length)
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
 *
 * Two questions, not one. A count answers "how many" and nothing else, so a
 * database migrated on another branch to the same depth passed while holding a
 * different schema: switch branches, run the suite, and the failure is again a
 * column that does not exist. Drizzle's ledger stores the sha256 of each
 * migration's SQL, and the journal on disk names the file, so the last entry
 * can be compared by identity as well.
 *
 * It does not store the tag, which is why the hash is what gets compared.
 */
export async function assertMigrationsApplied(client, name, setupCommand) {
  const journalUrl = new URL(
    "../../drizzle/meta/_journal.json",
    import.meta.url,
  );
  const journal = JSON.parse(await readFile(journalUrl, "utf8"));
  const expected = journal.entries.length;

  const rows = await client
    .query(
      "select hash, created_at from drizzle.__drizzle_migrations order by created_at",
    )
    // 42P01: no ledger at all, so nothing has ever been migrated here.
    .then((result) => result.rows)
    .catch((error) => {
      if (codeOf(error) === "42P01") return [];
      throw error;
    });

  if (rows.length < expected) {
    throw new Error(
      `the database "${name}" is ${expected - rows.length} migration(s) ` +
        `behind the ones on disk. Run \`${setupCommand}\`.`,
    );
  }

  const last = journal.entries[expected - 1];
  if (!last) return;

  // The same sha256 drizzle-kit writes into the ledger: the whole text of the
  // .sql file, before it is split on statement breakpoints.
  const sql = await readFile(
    new URL(`../../drizzle/${last.tag}.sql`, import.meta.url),
    "utf8",
  );
  const hash = createHash("sha256").update(sql).digest("hex");

  if (rows.some((row) => row.hash === hash)) return;

  throw new Error(
    `the database "${name}" has ${rows.length} migration(s) applied, which is ` +
      `as many as there are on disk, but not the same ones: "${last.tag}" was ` +
      "never applied to it. That is what a database migrated on another branch " +
      `looks like. Run \`${setupCommand}\`.`,
  );
}

/**
 * The other half of the schema, which nothing used to check at all.
 *
 * Better Auth owns twelve tables and migrates them with its own migrator, from
 * the installed version of the library (see docs/07-phase-0-findings.md section
 * 3.1). So an upgrade of that dependency can add a table or a column with no
 * migration file anywhere in this repository, and the first sign of it is a raw
 * `relation "..." does not exist` from inside the library, on a sign-in.
 *
 * `getMigrations` is the same call `scripts/auth-migrate.ts` makes, asked what
 * it *would* do rather than told to do it, which makes it a check.
 *
 * It imports src/lib/auth.ts, which reads DATABASE_URL at import time, so the
 * caller has to have pointed the environment at the database it means: there is
 * no URL parameter here because there is nowhere to put one.
 *
 * That module also validates its configuration at import time and opens a pool,
 * which is why this is deliberately not on the path of
 * `npm test`: the suite never touches an auth table, and paying an import and a
 * pool per run to check something it does not use is the wrong trade. The
 * caller that needs it is `npm run dev:test`, which serves the sign-in this
 * would break.
 */
export async function assertAuthSchemaReady(setupCommand) {
  // Through tsx, not bare `node`. Node 26 strips the types out of a .ts file on
  // its own, but it does not rewrite an extensionless relative import, and
  // src/ is written the TypeScript way: `import { MCP_SCOPES } from "./scopes"`
  // resolves to nothing. tsx is the loader `npm run auth:migrate` already uses
  // for the same module, and it is a devDependency, so it is present wherever
  // this is called from.
  const { register } = await import("tsx/esm/api");
  const unregister = register();

  const [{ getMigrations }, { auth }] = await Promise.all([
    import("better-auth/db/migration"),
    import("../../src/lib/auth.ts"),
  ]).finally(unregister);

  try {
    const plan = await getMigrations(auth.options);
    const missing = [
      ...plan.toBeCreated.map((table) => table.table),
      ...plan.toBeAdded.map((table) => table.table),
    ];

    if (missing.length === 0 && plan.toBeAddedIndexes.length === 0) return;

    throw new Error(
      "the installed version of Better Auth expects schema this database does " +
        `not have: ${[...new Set(missing)].join(", ") || "indexes only"}. ` +
        `Run \`${setupCommand}\`, or \`npm run auth:migrate\` for the ` +
        "development database.",
    );
  } finally {
    // The module-level pool src/lib/auth.ts opens at import. Nothing else in
    // this process uses it, and leaving it open holds the event loop.
    await auth.options.database?.end?.();
  }
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
