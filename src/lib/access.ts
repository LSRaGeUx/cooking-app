/**
 * Who may hold an account on this instance, and who still holds one.
 *
 * Google sign-in proves an address, it does not grant access: anyone with a
 * Google account can reach the callback. The allowlist is the actual control.
 *
 * It is checked in four places, because one was not enough. Better Auth's
 * `user.validateUserInfo` in `src/lib/auth.ts` covers the way in: account
 * creation, account linking, and OAuth sign-in. That gate stops a stranger
 * getting an account, and it is all it stops. It does not run on email and
 * password sign-in of an account that already exists, and nothing about it
 * reaches a session cookie or an access token already issued.
 *
 * So access is re-read on the way through as well:
 *
 * - `requireUser()` in `src/lib/session.ts`, so a removed address stops loading
 *   pages on its next request rather than when its cookie expires.
 * - The consent screen, so a surviving cookie is not offered the chance to
 *   authorize a new agent client.
 * - `guardedCall()` in `src/mcp/tool-runner.ts`, which is the one that matters:
 *   an access token is a JWT valid for its full hour whatever we later think of
 *   its holder, so without this an agent connected before the removal keeps
 *   working, and a surviving cookie can mint another hour on demand. It refuses
 *   with `ACCESS_REVOKED`, kept distinct from `CLIENT_REVOKED` so an agent does
 *   not read it as "reconnect me" and loop.
 *
 * The list lives in the environment rather than in a table because there is no
 * admin screen to edit a table with, and a household list changes about twice a
 * year. Matching is exact after trimming and lowercasing: no dot or plus
 * folding, so the address has to be written the way the provider returns it.
 */

/** Rejection codes. They travel to `/login` as the `error` query parameter. */
export const NOT_ALLOWED = "email_not_allowed";
export const NOT_CONFIGURED = "allowlist_not_configured";

export type AccessResult =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly code: string };

/** Read lazily, so a test can set the variable and so a build cannot bake it in. */
export function allowedEmails(): readonly string[] {
  return (process.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map(normalize)
    .filter((entry) => entry.length > 0);
}

/**
 * An empty list is open in development, because a fresh clone has to be able to
 * create the first account, and closed in production, because an instance that
 * reaches the public internet with no list configured has no door on it. Locking
 * everyone out is the right way to fail: the login screen names the missing
 * variable, and no stranger gets an account in the meantime.
 */
export function checkAccess(
  email: string,
  options: {
    readonly list?: readonly string[];
    readonly requireList?: boolean;
  } = {},
): AccessResult {
  // Normalized here rather than only on the way out of the environment, so a
  // list handed in by a caller or a test behaves the same as a configured one.
  const list = (options.list ?? allowedEmails()).map(normalize).filter(Boolean);
  const requireList = options.requireList ?? process.env.NODE_ENV === "production";

  if (list.length === 0) {
    return requireList ? { allowed: false, code: NOT_CONFIGURED } : { allowed: true };
  }

  const candidate = normalize(email);
  if (candidate.length === 0) return { allowed: false, code: NOT_ALLOWED };

  return list.includes(candidate)
    ? { allowed: true }
    : { allowed: false, code: NOT_ALLOWED };
}

function normalize(email: string): string {
  return email.trim().toLowerCase();
}
