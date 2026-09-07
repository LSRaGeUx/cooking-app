import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { pgPolicy, pgRole, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * The least-privileged runtime role. Created by src/db/bootstrap.sql, so it is
 * declared as existing here rather than managed by drizzle-kit.
 */
export const appRole = pgRole("cooking_app").existing();

/**
 * Every user-owned row is scoped by this session variable, set per transaction
 * by withUser() in src/db/client.ts. `true` as the second argument to
 * current_setting means "return null instead of erroring when unset", and the
 * nullif turns the empty string a committed SET LOCAL leaves behind into null.
 * Together they make an unscoped query return zero rows instead of blowing up.
 * See docs/07-phase-0-findings.md section 2.4.
 */
export const currentUserId = sql`nullif(current_setting('app.user_id', true), '')`;

/**
 * Postgres 18 ships uuidv7() in core. Time-sortable primary keys keep inserts
 * clustered and make an id ordering meaningful, which matters for plan versions
 * and activity rows.
 */
export const primaryId = () =>
  uuid("id")
    .primaryKey()
    .default(sql`uuidv7()`);

/**
 * `text`, not `uuid`, because Better Auth owns the `user` table and its `id`
 * column is text. See docs/02-data-model.md section 2. There is no foreign key
 * for the same reason: the two migrators run in sequence and Drizzle's runs
 * first, so the referenced table does not exist yet.
 */
export const ownerId = () => text("user_id").notNull();

export const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/**
 * `$onUpdate` is what makes this column mean what its name says. `defaultNow()`
 * fires on insert only, so nothing moved it afterwards and every service had to
 * remember to set it by hand; the ones that forgot left a row whose
 * `updated_at` equalled its `created_at` forever. Drizzle now writes the value
 * into every update statement it builds, so no caller has to think about it.
 *
 * It is applied by the ORM rather than by a trigger on purpose: a trigger would
 * also fire for the migrator and for a manual `psql` correction, and "when did
 * the application last change this row" is the question the column answers.
 */
export const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

/**
 * The second line of defence behind withUser(). Policy names are per-table in
 * Postgres, but they are prefixed with the table name anyway so a failing
 * policy is identifiable from an error message alone.
 */
export function ownerPolicy(name: string, userIdColumn: AnyPgColumn) {
  return pgPolicy(name, {
    for: "all",
    to: appRole,
    using: sql`${userIdColumn} = ${currentUserId}`,
    withCheck: sql`${userIdColumn} = ${currentUserId}`,
  });
}
