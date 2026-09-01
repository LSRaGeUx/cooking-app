import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { jwt } from "better-auth/plugins";
import { mcp } from "@better-auth/mcp";
import { Pool } from "pg";
import { MCP_SCOPES } from "./scopes";
import { checkAccess } from "./access";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

const googleCredentials =
  process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
    ? {
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      }
    : undefined;

/**
 * Password sign-in is a development affordance, not a product feature. It is off
 * unless asked for, because a second door into the same accounts is a second
 * door to defend, and because `npm run verify:oauth` has no way to drive a
 * Google consent screen and needs credentials to sign in with.
 */
const passwordLoginEnabled = process.env.AUTH_PASSWORD_LOGIN === "true";

if (!googleCredentials && !passwordLoginEnabled) {
  throw new Error(
    "No sign-in method configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, " +
      "or AUTH_PASSWORD_LOGIN=true for local development.",
  );
}

/** What the login screen should offer. Derived here so there is one answer. */
export const signInMethods = {
  google: googleCredentials !== undefined,
  passwordLogin: passwordLoginEnabled,
} as const;

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
    enabled: passwordLoginEnabled,
  },
  socialProviders: googleCredentials ? { google: googleCredentials } : {},
  user: {
    /**
     * The access gate. Better Auth calls this before creating a user, before
     * linking an account, and on every OAuth sign-in, across every method, so
     * one rule covers Google, the development password door, and anything added
     * later. Returning `{ error }` turns into a redirect to `errorCallbackURL`
     * carrying the code, which `/login` translates.
     */
    validateUserInfo: ({ user }) => {
      const email = typeof user.email === "string" ? user.email : "";
      const result = checkAccess(email);
      if (result.allowed) return;
      return { error: result.code, errorDescription: "Address not permitted on this instance" };
    },
  },
  account: {
    // One provider, so linking has nothing to link. Off, it removes the case
    // where a second identity claiming an allowlisted address inherits the
    // account that already holds it. An account already linked is unaffected:
    // sign-in finds it by provider and account id, before the linking branch.
    accountLinking: { enabled: false },
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
