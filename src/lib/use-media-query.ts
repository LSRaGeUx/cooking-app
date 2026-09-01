"use client";

import { useSyncExternalStore } from "react";

/**
 * Reads a media query in React, without rendering the wrong thing first.
 *
 * The week grid is two different structures, a wall on a wide screen and a
 * stack of days on a narrow one, and they cannot both be mounted: they share
 * drag-and-drop ids, and two droppables with the same id is a silent bug. So
 * the layout is chosen rather than hidden with CSS.
 *
 * The server snapshot returns false, so the narrow structure renders first and
 * a phone never pays for a layout it will not use.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}
