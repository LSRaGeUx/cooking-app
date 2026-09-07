/**
 * Every environment variable this application reads, resolved in one place.
 *
 * Server-only. It touches `node:fs` to support the `_FILE` indirection below, so
 * it must never reach a client bundle. Import it from a server component, a
 * route handler, a service or a script.
 *
 * Two rules hold here and nowhere else:
 *
 * 1. **A development default never applies in production.** Reading
 *    `BETTER_AUTH_URL` with a silent `?? "http://localhost:3000"` fallback used
 *    to happen in three files. On a deployed instance that hands agents a dead
 *    review link and breaks the OAuth issuer, cookie attributes and origin
 *    checks, with nothing failing loudly. Here the fallback exists only when
 *    `NODE_ENV !== "production"`, and the production path throws with the name
 *    of the variable that is missing.
 *
 * 2. **A secret may arrive as a file.** Compose and Kubernetes both mount
 *    secrets as files rather than environment, which keeps them out of
 *    `docker inspect` and out of the environment of every child process. Any
 *    variable read through `secret()` accepts `<NAME>_FILE` holding a path, and
 *    prefers it when both are set. Plain `<NAME>` keeps working, so an existing
 *    deployment needs no change.
 *
 * Everything is a function rather than a module constant. `next build` imports
 * this transitively and must not bake a build-time value into the bundle, and a
 * test has to be able to set a variable after import.
 */

import { readFileSync } from "node:fs";

const DEV_BASE_URL = "http://localhost:3000";

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/** Reads a variable, or throws naming it. */
export function required(name: string): string {
  const value = read(name);
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

/** Reads a variable, or undefined when it is unset or empty. */
export function optional(name: string): string | undefined {
  return read(name) || undefined;
}

/**
 * Reads a secret, preferring `<NAME>_FILE` over `<NAME>`. Throws naming both
 * spellings, since a deployment using the file form gets no help from an error
 * that mentions only the variable.
 */
export function secret(name: string): string {
  const value = readSecret(name);
  if (!value) {
    throw new Error(`Missing required secret: set ${name} or ${name}_FILE`);
  }
  return value;
}

/** As `secret`, but undefined rather than throwing. */
export function optionalSecret(name: string): string | undefined {
  return readSecret(name) || undefined;
}

/**
 * Required in production, defaulted in development. Use for values that have a
 * sensible local answer and no safe production guess.
 */
function requiredInProduction(
  name: string,
  developmentDefault: string,
): string {
  const value = read(name);
  if (value) return value;
  if (isProduction()) {
    throw new Error(
      `Missing required env var: ${name}. It has a development default, ` +
        "but a production instance needs the real address: it is the OAuth " +
        "issuer, it sets cookie attributes, and it is the base of every link " +
        "handed to an agent.",
    );
  }
  return developmentDefault;
}

/**
 * The address this instance serves on, with no trailing slash.
 *
 * Better Auth's issuer, the base of the review links `propose_week` returns, and
 * the origin the consent screen is checked against, so all three agree.
 */
export function baseUrl(): string {
  return stripTrailingSlash(
    requiredInProduction("BETTER_AUTH_URL", DEV_BASE_URL),
  );
}

/**
 * The canonical URL of the MCP endpoint, which issued tokens are audience-bound
 * to (RFC 8707). It must match what an agent connects to exactly, so it is not
 * derived from `baseUrl()`.
 */
export function mcpResource(): string {
  return requiredInProduction("MCP_RESOURCE", `${DEV_BASE_URL}/api/mcp`);
}

/** The owner role. Migrations only; see the header of src/db/client.ts. */
export function ownerDatabaseUrl(): string {
  return secret("DATABASE_URL");
}

/** The NOBYPASSRLS role everything at runtime connects as. */
export function appDatabaseUrl(): string {
  return secret("APP_DATABASE_URL");
}

/** Password sign-in. A development affordance; see src/lib/auth.ts. */
export function passwordLoginEnabled(): boolean {
  return read("AUTH_PASSWORD_LOGIN") === "true";
}

export function googleCredentials():
  | { readonly clientId: string; readonly clientSecret: string }
  | undefined {
  const clientId = optional("GOOGLE_CLIENT_ID");
  const clientSecret = optionalSecret("GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) return undefined;
  return { clientId, clientSecret };
}

function read(name: string): string | undefined {
  return process.env[name];
}

function readSecret(name: string): string | undefined {
  const path = read(`${name}_FILE`);
  if (path) {
    try {
      return readFileSync(path, "utf8").trim();
    } catch (error) {
      throw new Error(
        `Could not read ${name}_FILE at ${path}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return read(name);
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
