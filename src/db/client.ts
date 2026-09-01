import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
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
 */
const connectionString = process.env.APP_DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "APP_DATABASE_URL must be set. It is the NOBYPASSRLS role the application " +
      "connects as at runtime; DATABASE_URL is the owner and is for migrations " +
      "only. Run `npm run db:bootstrap` to create the role.",
  );
}

const pool = new Pool({ connectionString, max: 10 });

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
 */
export async function withUser<T>(
  userId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    return fn(tx);
  });
}

export { schema };
