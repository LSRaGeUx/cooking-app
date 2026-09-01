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
 */
const CACHE = "cooking-app-v1";
const SHELL = ["/manifest.webmanifest", "/icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
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
  if (!isGrocery && !SHELL.includes(url.pathname)) return;

  // Network first, so a list that can be refreshed is refreshed. The cache is
  // the fallback for the aisle with no signal, not the default answer.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && isGrocery) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        throw new Error("offline and not cached");
      }),
  );
});
