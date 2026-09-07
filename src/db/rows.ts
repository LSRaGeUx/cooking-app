/**
 * Reading a row out of a `.returning()` result without a non-null assertion.
 *
 * Drizzle types every `insert().returning()` and `update().returning()` as an
 * array, so the fourteen call sites that write exactly one row all ended in
 * `rows[0]!`. Under `noUncheckedIndexedAccess` the assertion is the only thing
 * that compiles, and it turns a query that unexpectedly matched nothing into a
 * `TypeError` about `undefined` several frames later, in whichever mapper first
 * reads a field.
 *
 * `firstRow` fails at the query instead, saying which one. An update whose
 * `where` matched no row is the usual cause, and on a user-owned table that
 * usually means the id belongs to another tenant, which row-level security turns
 * into an empty result rather than an error.
 */
export function firstRow<T>(rows: readonly T[], what: string): T {
  const row = rows[0];
  if (row === undefined) {
    throw new Error(
      `Expected ${what} to return a row and it returned none. The filter ` +
        "matched nothing: either the id does not exist, or it belongs to " +
        "another user and row-level security hid it.",
    );
  }
  return row;
}

/**
 * The at-most-one variant, for a read where absence is a legitimate answer the
 * caller handles.
 */
export function maybeRow<T>(rows: readonly T[]): T | undefined {
  return rows[0];
}
