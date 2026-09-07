import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { appDatabaseUrl } from "@/lib/config";
import * as schema from "./schema";

/**
 * Runtime connections use APP_DATABASE_URL, which is the non-owner role, so
 * row-level security applies. DATABASE_URL is the owner and is reserved for
 * migrations.
 *
 * There is deliberately no fallback to DATABASE_URL. Postgres exempts a table
 * owner from row-level security, so falling back would keep the application
 * running while quietly removing the second line of defence on every
 * user-owned table, and nothing in the test suite would notice. Refusing to
 * boot is the loud failure this deserves.
 *
 * Read through `appDatabaseUrl()` rather than off `process.env`, so a
 * deployment can mount the URL as a file through `APP_DATABASE_URL_FILE`. It
 * throws when neither is set, with the same guidance the check here used to
 * carry: the variable names the NOBYPASSRLS role, and `npm run db:bootstrap`
 * creates it.
 */
const connectionString = appDatabaseUrl();

/**
 * Pool settings, each of which is a deliberate choice rather than a default.
 *
 * `max: 10` is per process, and there are several: the Next server, the
 * migrator, and the test runner. Ten leaves room under a default Postgres
 * `max_connections` of 100 for all of them plus a psql session.
 *
 * `idleTimeoutMillis` closes a connection nobody has used for thirty seconds.
 * Without it, a pool that peaked once holds ten connections open for the life
 * of the process, and on a single-instance self-hosted database that is ten
 * connections the backup and the migrator cannot have. Thirty seconds is longer
 * than the gap between requests in any active session, so a busy server does
 * not churn connections.
 *
 * `connectionTimeoutMillis` fails a request that cannot get a connection within
 * five seconds. The default is to wait forever, which under load turns a
 * saturated pool into a pile of requests that never answer and a page that
 * never finishes loading. Five seconds is long enough to ride out a slow
 * checkout and short enough that the caller gets an error it can show.
 *
 * `statement_timeout` is set on the connection rather than on the role, so it
 * travels with the application and not with the database. Fifteen seconds is
 * far beyond any query this application issues, and it is the backstop for the
 * one that goes wrong: a missing index or an accidental cross join otherwise
 * holds a connection, and its locks, until someone notices.
 */
const pool = new Pool({
  connectionString,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  options: "-c statement_timeout=15000",
});

/**
 * node-postgres emits `error` on the pool when an idle client's connection
 * drops, which happens on every database restart, every failover and every
 * idle-connection reaper on the network path between the two. An unhandled
 * `error` on an EventEmitter is an uncaught exception, so without this handler
 * restarting Postgres takes the application down with it. Logging is the whole
 * job: the pool discards the dead client itself and the next query gets a fresh
 * one.
 */
pool.on("error", (error) => {
  console.error("[db] idle client error, connection discarded:", error);
});

export const db = drizzle(pool, { schema });
export type Db = typeof db;

/**
 * The transaction handle every scoped query runs on. Services accept it so a
 * service can compose another one without opening a second transaction, which
 * would defeat the atomicity a plan version write depends on.
 */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Runs `fn` inside a transaction whose `app.user_id` is set, which is what every
 * RLS policy reads. SET LOCAL is transaction-scoped, so a pooled connection
 * cannot leak the setting to the next request.
 *
 * Every read or write of a user-owned table goes through this. A query that
 * forgets it does not error, it returns zero rows, which is the intended
 * failure mode: silent-but-empty rather than a silent leak.
 *
 * An empty `userId` is refused up front. `currentUserId` in
 * src/db/schema/_shared.ts is `nullif(current_setting(...), '')`, precisely so
 * that a transaction with no setting reads as null and returns nothing; an
 * empty string reaches the same state, so a caller that lost its session id
 * along the way would get a transaction that reads zero rows and refuses every
 * write, with no error anywhere. That failure mode is correct as a defence and
 * useless as a diagnosis, so a caller bug is made loud here instead.
 */
export async function withUser<T>(
  userId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (userId.length === 0) {
    throw new Error(
      "withUser() was called with an empty userId. Every user-owned query is " +
        "scoped by it, and an empty value would silently return zero rows and " +
        "silently refuse every write. Resolve the session before opening the " +
        "transaction.",
    );
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    return fn(tx);
  });
}

export { schema };
