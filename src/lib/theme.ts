/**
 * Light is the product, dark is a preference.
 *
 * The application is a paper ledger: warm ground, ink, a hot accent. Following
 * the operating system meant most people never saw the thing that was designed,
 * they saw its inversion. So the default is light for everyone, and dark is
 * something you ask for and keep.
 *
 * Stored in a cookie rather than localStorage, so the server renders the right
 * ground on the first byte. A theme resolved in the browser is a flash of the
 * wrong colour on every navigation.
 */
export const themes = ["light", "dark"] as const;
export type Theme = (typeof themes)[number];

export const defaultTheme: Theme = "light";

export const THEME_COOKIE = "theme";

export function isTheme(value: string | undefined): value is Theme {
  return value !== undefined && (themes as readonly string[]).includes(value);
}
