/**
 * Who may hold an account on this instance.
 *
 * Google sign-in proves an address, it does not grant access: anyone with a
 * Google account can reach the callback. The allowlist is the actual control.
 * It is enforced by `user.validateUserInfo` in `src/lib/auth.ts`, which Better
 * Auth calls on account creation, on account linking, and on every OAuth
 * sign-in. Dropping an address therefore blocks the next sign-in, though it
 * does not revoke a session cookie already issued.
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
