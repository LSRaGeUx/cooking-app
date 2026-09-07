import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { jwt } from "better-auth/plugins";
import { mcp } from "@better-auth/mcp";
import { Pool } from "pg";
import {
  baseUrl,
  googleCredentials,
  mcpResource,
  appDatabaseUrl,
  passwordLoginEnabled,
  secret,
} from "./config";
import { MCP_SCOPES } from "./scopes";
import { checkAccess } from "./access";

/**
 * Every value read here comes from `@/lib/config`, which is now the only file
 * in `src/` allowed to touch `process.env` and the only one that knows a secret
 * may arrive as a file. This module used to keep its own `required()` helper and
 * read four variables directly, including a `?? "http://localhost:3000"`
 * fallback for the base URL that applied in production too, where it silently
 * broke the OAuth issuer, the cookie attributes and the origin checks.
 */

const google = googleCredentials();

/**
 * Password sign-in is a development affordance, not a product feature. It is off
 * unless asked for, because a second door into the same accounts is a second
 * door to defend, and because `npm run verify:oauth` has no way to drive a
 * Google consent screen and needs credentials to sign in with.
 *
 * It exists on the HTTP API only. Nothing in the UI offers it, and there is no
 * sign-up screen: the flag opens `/api/auth/sign-in/email` and
 * `/api/auth/sign-up/email` for that script and for nobody else.
 */
const passwordLogin = passwordLoginEnabled();

if (!google && !passwordLogin) {
  throw new Error(
    "No sign-in method configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, " +
      "or AUTH_PASSWORD_LOGIN=true for local development.",
  );
}

/** What the login screen should offer. Derived here so there is one answer. */
export const signInMethods = {
  google: google !== undefined,
} as const;

/**
 * mcp() IS the OAuth 2.1 / OIDC provider, configured for MCP: it audience-binds
 * issued tokens to `resource` (RFC 8707) and serves the RFC 9728 protected
 * resource metadata that MCP clients discover. Dynamic client registration is
 * opt-in, hence both registration flags below: an MCP client arriving cold has
 * no pre-registered client_id.
 *
 * **On the connection role.** This pool is the runtime role, not the owner,
 * which is what CLAUDE.md requires of anything the application uses to serve a
 * request. It used to be the owner, and the reason was never the grants:
 * `src/db/bootstrap.sql` grants `cooking_app` full DML on every table in
 * `public` and sets default privileges for tables created later, so Better
 * Auth's twelve tables were always reachable by the runtime role. The reason was
 * that `scripts/auth-migrate.ts` imports this module and ran Better Auth's own
 * migrator through `auth.options`, so the pool declared here had to be able to
 * CREATE TABLE, and one module cannot be both roles.
 *
 * That script now builds its own owner pool and overrides `database` for the
 * migration run, so this one no longer has to. The gain is that the serving
 * process stops holding a credential that reaches every domain table and
 * bypasses row-level security on all of them.
 *
 * Tenancy on the auth tables themselves is unchanged, because they carry no
 * row-level security policy: the runtime role is not scoped on them and the
 * owner role was bypassing nothing that exists. Better Auth scopes its own
 * queries by session and by user id, which is the only thing that ever guarded
 * them.
 *
 * **On the secret.** It is passed explicitly. Better Auth reads
 * `BETTER_AUTH_SECRET` from `process.env` inside the library, which used to be
 * the argument for leaving it out, and that argument no longer holds: a
 * deployment can now mount the secret as `BETTER_AUTH_SECRET_FILE` through
 * `deploy/compose.secrets.yaml`, and only `secret()` knows how to read the file
 * form. Left implicit, the mounted file would be silently ignored and the
 * library would report a missing secret.
 *
 * `secret()` throws at import time, which is what keeps the guard honest after
 * `compose.yaml` dropped its `${NAME:?}` checks: the migrator imports this
 * module, so a deployment missing a secret fails before the application ever
 * serves a request.
 */
export const auth = betterAuth({
  database: new Pool({ connectionString: appDatabaseUrl() }),
  secret: secret("BETTER_AUTH_SECRET"),
  baseURL: baseUrl(),
  emailAndPassword: {
    enabled: passwordLogin,
  },
  socialProviders: google ? { google } : {},
  /**
   * Dynamic client registration is unauthenticated by necessity: an MCP client
   * arriving cold has no credential to present, and that is the whole one-URL
   * connection story. Unauthenticated and unbounded is another matter, so the
   * one endpoint that can create rows without a session gets a rule of its own.
   * Everything else keeps the library default.
   *
   * A registered client with no consent opens nothing: `guardedCall` in
   * src/mcp/tool-runner.ts refuses every call whose (user, client) pair has no
   * consent row. So the exposure is rows in `oauthApplication`, and the rate
   * limit is what bounds how fast they can arrive.
   *
   * Storage is left at the library default, which is in-process memory. That is
   * the right answer for a single-container deployment and the wrong one for
   * several: the database-backed store would need a `rateLimit` table, which is
   * a schema change, and there is one container.
   */
  rateLimit: {
    customRules: {
      "/oauth2/register": { window: 60, max: 5 },
    },
  },
  user: {
    /**
     * The gate on the way in. Better Auth calls this before creating a user,
     * before linking an account, and on OAuth sign-in, so it covers Google, the
     * sign-up half of the development password door, and anything added later.
     * Returning `{ error }` turns into a redirect to `errorCallbackURL` carrying
     * the code, which `/login` translates.
     *
     * It is a creation gate, not a session one. It does not run when an existing
     * account signs in with a password, and it cannot reach a cookie or a token
     * already issued, so removing an address here does not by itself end an
     * access already granted. `checkAccess` is therefore re-read on every
     * authenticated request and on every MCP call; see the header of
     * src/lib/access.ts for the four places and why each is needed.
     */
    validateUserInfo: ({ user }) => {
      const email = typeof user.email === "string" ? user.email : "";
      const result = checkAccess(email);
      if (result.allowed) return;
      return {
        error: result.code,
        errorDescription: "Address not permitted on this instance",
      };
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
      resource: mcpResource(),
      scopes: [...MCP_SCOPES],
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      // Pinned rather than defaulted, because two comments assert it: the
      // revocation check in src/mcp/tool-runner.ts and the header of
      // src/lib/access.ts both reason from an access token being valid for an
      // hour, and a library default that changed in a patch release would make
      // both of them quietly wrong. One hour is also what the default is, so
      // this changes no behaviour today. It is the MCP access token's lifetime
      // that those comments are about, not the `jwt()` plugin's own token
      // endpoint, which is not on the agent path at all.
      accessTokenExpiresIn: 3600,
    }),
    // Must stay last: it wraps the response so a server action that signs a
    // user in can set the session cookie. Anything after it would not be
    // wrapped.
    nextCookies(),
  ],
});

export type Auth = typeof auth;
