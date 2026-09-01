/**
 * The locale constants, kept apart from the request config on purpose.
 *
 * The switcher is a client component, and `request.ts` reads `next/headers`.
 * Importing one from the other would drag a server-only API into the browser
 * bundle, which fails the build rather than failing quietly.
 */
export const locales = ["fr", "en"] as const;
export type Locale = (typeof locales)[number];

/** French, because that is the language the product is written in. */
export const defaultLocale: Locale = "fr";

export const LOCALE_COOKIE = "NEXT_LOCALE";

export function isLocale(value: string | undefined): value is Locale {
  return value !== undefined && (locales as readonly string[]).includes(value);
}
