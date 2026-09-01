"use client";

import { useEffect } from "react";

/**
 * Registers the service worker, and only in production.
 *
 * In development a cached response is a confusing bug rather than a feature, so
 * any worker left over from a production build is unregistered instead.
 */
export function ServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    if (process.env.NODE_ENV !== "production") {
      void navigator.serviceWorker
        .getRegistrations()
        .then((registrations) =>
          Promise.all(
            registrations.map((registration) => registration.unregister()),
          ),
        )
        .catch(() => undefined);
      return;
    }

    void navigator.serviceWorker.register("/sw.js").catch(() => {
      // A browser that refuses the worker still gets the whole application.
      // There is nothing to tell the user.
    });
  }, []);

  return null;
}
