"use client";

/**
 * Signing out, in one place.
 *
 * It was written twice, in the app navigation and on the login screen, and the
 * navigation's copy had no pending state and no error handling: a failed fetch
 * became an unhandled rejection and the user stayed signed in with no sign that
 * anything had happened.
 *
 * The two things easy to get wrong here are both fixed below. The body and its
 * content type are not optional: the endpoint declares the media types it
 * accepts and answers 415 to a POST that names none, which fails silently
 * because nothing reads the response. And the grocery list is cached by the
 * service worker for the aisle with no signal, so on a shared device the last
 * shop would stay readable after signing out. The cache is dropped here, before
 * the session goes, rather than left to the next install of a new worker.
 *
 * Navigation is left to the caller: a component knows whether it wants
 * `router.replace` or a full reload, and this function has no router.
 */
export async function signOut(): Promise<void> {
  // Order matters only in that the cache must go even if the request fails, so
  // it is cleared first and the sign-out is what may throw.
  await clearOfflineCaches();

  await fetch("/api/auth/sign-out", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
}

/**
 * Every cache this application owns, dropped. The names are versioned per build
 * (see public/sw.js), so the prefix is matched rather than one exact name.
 */
async function clearOfflineCaches(): Promise<void> {
  if (typeof caches === "undefined") return;
  try {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key.startsWith("cooking-app"))
        .map((key) => caches.delete(key)),
    );
  } catch {
    // A browser with the Cache API behind a permission, or a private window:
    // there is nothing cached to leak in that case either.
  }
}
