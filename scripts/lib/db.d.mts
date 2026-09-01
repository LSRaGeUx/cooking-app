// Hand-written because the module is plain JavaScript on purpose: the setup and
// bootstrap scripts run under bare `node`, before any TypeScript loader exists.
// The Vitest setup files are TypeScript and import it, so it needs a shape.

/** The development URL with `_test` appended to the database name. */
export function deriveTestUrl(url: string): string;

/** The database name a connection URL points at, percent-decoded. */
export function databaseNameOf(url: string): string;

/** Owner and runtime URLs for the test database, honouring TEST_* overrides. */
export function testUrls(env?: NodeJS.ProcessEnv): {
  readonly owner: string;
  readonly app: string;
};

/** Creates the database if it is absent. Reports which of the two happened. */
export function ensureDatabase(
  adminUrl: string,
  name: string,
): Promise<"created" | "present">;

/** Creates the least-privileged runtime role and its grants. Idempotent. */
export function applyBootstrap(
  ownerUrl: string,
  appPassword: string,
): Promise<void>;
