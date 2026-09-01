// Hand-written because the module is plain JavaScript on purpose: the setup and
// bootstrap scripts run under bare `node`, before any TypeScript loader exists.
// The Vitest setup files are TypeScript and import it, so it needs a shape.

/** The development URL with `_test` appended to the database name. */
export function deriveTestUrl(url: string): string;

/** The database name a connection URL points at, percent-decoded. */
export function databaseNameOf(url: string): string;

/** The password node-postgres will connect with, percent-decoded like it does. */
export function passwordOf(url: string): string;

/** The same URL with its credential replaced, safe to print in an error. */
export function redactUrl(url: string): string;

/** Owner and runtime URLs for the test database, honouring TEST_* overrides. */
export function testUrls(env?: NodeJS.ProcessEnv): {
  readonly owner: string;
  readonly app: string;
};

/**
 * Throws unless both URLs name one database of their own, named with a `_test`
 * suffix. Returns that name.
 */
export function assertTestUrls(
  urls: { readonly owner: string; readonly app: string },
  env?: NodeJS.ProcessEnv,
): string;

/** A connection to another database on the same instance, for CREATE DATABASE. */
export function adminUrlFor(url: string, fallback?: string): string;

/** Creates the database if it is absent. Reports which of the two happened. */
export function ensureDatabase(
  adminUrl: string,
  name: string,
): Promise<"created" | "present">;

/**
 * Creates the least-privileged runtime role and its grants. Idempotent, but it
 * also re-applies the cluster-wide password, so pass the application's own.
 */
export function applyBootstrap(
  ownerUrl: string,
  appPassword: string,
): Promise<void>;
