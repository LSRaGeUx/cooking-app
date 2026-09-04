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

/**
 * `--panel` per theme, duplicated out of globals.css because the browser needs
 * it as a meta tag before any stylesheet is parsed.
 *
 * The panel and not the ground, even though the ground is the page. This is the
 * colour the operating system paints in the strip it keeps for itself: the
 * status bar of a standalone launch, which sits directly on top of the bar, and
 * the browser furniture around the page in Safari, which sits directly under
 * the phone tab strip. Both of those neighbours are panel. Handing over the
 * ground put an unruled seam across the top of the screen, and an edge with no
 * rule on it is the one thing this language does not do.
 */
export const themeColor: Record<Theme, string> = {
  light: "#ffffff",
  dark: "#171716",
};
