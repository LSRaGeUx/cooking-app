import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { jwt } from "better-auth/plugins";
import { mcp } from "@better-auth/mcp";
import { Pool } from "pg";
import { MCP_SCOPES } from "./scopes";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

/**
 * Better Auth owns its own tables and migrates them with its own migrator
 * (scripts/auth-migrate.mjs), so it connects with the owner role. Drizzle owns
 * the domain tables and connects with the least-privileged role. See
 * docs/04-tech-spec.md.
 *
 * mcp() IS the OAuth 2.1 / OIDC provider, configured for MCP: it audience-binds
 * issued tokens to `resource` (RFC 8707) and serves the RFC 9728 protected
 * resource metadata that MCP clients discover. Dynamic client registration is
 * opt-in, hence both registration flags below: an MCP client arriving cold has
 * no pre-registered client_id.
 */
// BETTER_AUTH_SECRET is read from the environment by the library itself, which
// also validates its length and entropy and fails loudly when it is missing.
// Passing it here would only duplicate that.
export const auth = betterAuth({
  database: new Pool({ connectionString: required("DATABASE_URL") }),
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
  emailAndPassword: {
    enabled: true,
  },
  plugins: [
    jwt(),
    mcp({
      loginPage: "/login",
      consentPage: "/consent",
      resource: required("MCP_RESOURCE"),
      scopes: [...MCP_SCOPES],
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
    }),
    // Must stay last: it wraps the response so a server action that signs a
    // user in can set the session cookie. Anything after it would not be
    // wrapped.
    nextCookies(),
  ],
});

export type Auth = typeof auth;
