/*
 * A deliberately small service worker.
 *
 * Its only job is the grocery list, which is the one screen used in a shop with
 * bad signal. Everything else falls through to the network: caching the whole
 * app would mean serving stale plans and stale profiles, which is worse than an
 * offline page.
 *
 * Check-state replay is not here either. It lives in the grocery screen, in
 * localStorage, because a queued tick has to survive the service worker being
 * evicted and has to be replayed by code that knows which server action to call.
 *
 * The first version of this file cached the grocery HTML document and nothing
 * else, which made it worse than useless offline: the document loaded, none of
 * the JavaScript it references did, so the page rendered as server HTML with
 * dead checkboxes and the queued-tick replay never ran. Caching a document
 * means caching what the document needs, so the assets it references are
 * fetched and stored beside it.
 *
 * That also settles the cache name. A cached document referencing chunk hashes
 * a later deploy has deleted is a page that cannot boot, so the cache has to be
 * per build. The set of `/_next/static/` URLs a document references is
 * content-hashed by the bundler, so its digest *is* the build id: no version
 * constant to bump and nothing to wire through the environment. When a document
 * arrives whose digest differs from what is stored, the previous build's cache
 * is dropped whole.
 */

const CACHE_PREFIX = "cooking-app-";
const SHELL_CACHE = `${CACHE_PREFIX}shell`;
const DOCUMENTS_PREFIX = `${CACHE_PREFIX}courses-`;

const SHELL = ["/manifest.webmanifest", "/icon.svg"];

/** More assets than any page of this application references. A loop guard. */
const MAX_ASSETS = 120;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            // Anything of ours that is neither the shell nor a per-build
            // document cache. That includes "cooking-app-v1", the single
            // unversioned cache this worker used to keep everything in.
            .filter(
              (key) =>
                key.startsWith(CACHE_PREFIX) &&
                key !== SHELL_CACHE &&
                !key.startsWith(DOCUMENTS_PREFIX),
            )
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const isGrocery = url.pathname.startsWith("/courses/");
  const isAsset = url.pathname.startsWith("/_next/static/");
  if (!isGrocery && !isAsset && !SHELL.includes(url.pathname)) return;

  /*
   * Network first for everything, so a list that can be refreshed is
   * refreshed and a chunk is never served from a build the page is not on.
   * The cache is the fallback for the aisle with no signal, not the default
   * answer.
   */
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && isGrocery) {
          // Inside waitUntil, not fire and forget. The worker can be
          // terminated as soon as the response is returned, and the previous
          // version left this write racing that.
          event.waitUntil(storeDocument(request, response.clone()));
        }
        return response;
      })
      .catch(async () => {
        // Searches every cache, so an offline load finds the document and its
        // chunks whichever build's cache they are in.
        const cached = await caches.match(request);
        if (cached) return cached;
        throw new Error("offline and not cached");
      }),
  );
});

/**
 * Stores one grocery document together with every `/_next/static/` asset it
 * references, in the cache belonging to the build those assets come from.
 */
async function storeDocument(request, response) {
  const html = await response.clone().text();
  const assets = referencedAssets(html);
  const cacheName = DOCUMENTS_PREFIX + (await buildIdOf(assets));
  const cache = await caches.open(cacheName);

  await cache.put(request, response);

  await Promise.all(
    assets.map(async (asset) => {
      // Already stored by an earlier page of the same build.
      if (await cache.match(asset)) return;
      try {
        const fetched = await fetch(asset, { credentials: "same-origin" });
        if (fetched.ok) await cache.put(asset, fetched);
      } catch {
        // One missing chunk is not worth abandoning the rest.
      }
    }),
  );

  // Every other per-build cache is a previous deploy. Its documents reference
  // chunks this deploy no longer serves, so keeping them offers the shop a page
  // that cannot start.
  const keys = await caches.keys();
  await Promise.all(
    keys
      .filter((key) => key.startsWith(DOCUMENTS_PREFIX) && key !== cacheName)
      .map((key) => caches.delete(key)),
  );
}

/** Every same-origin build asset the document names, deduplicated. */
function referencedAssets(html) {
  const found = new Set();
  const pattern = /["'](\/_next\/static\/[^"'\s>]+)["']/g;
  let match = pattern.exec(html);
  while (match !== null && found.size < MAX_ASSETS) {
    // Next escapes ampersands in HTML attributes; the URL needs the character.
    found.add(match[1].replace(/&amp;/g, "&"));
    match = pattern.exec(html);
  }
  return [...found];
}

/**
 * A short digest of the sorted asset list. Content-hashed filenames make it
 * stable within a build and different across builds, which is exactly what a
 * cache name needs. Falls back to a fixed token where SubtleCrypto is not
 * available, which costs only the per-build separation.
 */
async function buildIdOf(assets) {
  const joined = [...assets].sort().join("\n");
  if (joined.length === 0) return "unknown";

  try {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(joined),
    );
    return [...new Uint8Array(digest)]
      .slice(0, 8)
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return "unknown";
  }
}
