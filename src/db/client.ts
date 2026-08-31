import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import * as schema from "./schema";

/**
 * Runtime connections use APP_DATABASE_URL, which is the non-owner role, so
 * row-level security applies. DATABASE_URL is the owner and is reserved for
 * migrations.
 */
const connectionString =
  process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("APP_DATABASE_URL or DATABASE_URL must be set");
}

const pool = new Pool({ connectionString, max: 10 });

export const db = drizzle(pool, { schema });
export type Db = typeof db;

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
  fn: (tx: Parameters<Parameters<Db["transaction"]>[0]>[0]) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    return fn(tx);
  });
}

export { schema };
