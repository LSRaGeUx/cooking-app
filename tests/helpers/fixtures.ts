import { randomUUID } from "node:crypto";
import { userContext, type ServiceContext } from "@/services/context";

/**
 * Service tests run against the real Postgres from compose.yaml, connected as
 * the non-owner role. Row-level security, check constraints, partial unique
 * indexes and the generated search vector are exactly the kind of rule a mock
 * would happily pretend to enforce, and three of them are load-bearing.
 *
 * The user id is a bare uuid rather than a real Better Auth user: the domain
 * tables carry no foreign key to that table, because the two migrators run in
 * sequence and Drizzle's runs first.
 */
export function testUser(): ServiceContext {
  return userContext(randomUUID());
}

/**
 * `cleanupUser` used to live here as a hand-written list of twenty-one tables in
 * foreign key order. It is now derived from the Drizzle schema in
 * `tests/helpers/index.ts`, because the hand-written list stopped covering a
 * table the moment one was added, and the rows it left behind leaked into the
 * next file's user until the global truncate. Import it, and everything else a
 * test needs, from `tests/helpers` rather than from here.
 */
