"use server";

import { isTheme, THEME_COOKIE } from "@/lib/theme";
import { setPreferenceCookie } from "./preference-cookie";

/**
 * The theme is a browser preference, not account data: it needs no session and
 * touches nothing owned by a user. Same shape as the locale action, on purpose,
 * and now the same implementation underneath it.
 */
export async function setThemeAction(value: string): Promise<void> {
  if (!isTheme(value)) return;
  await setPreferenceCookie(THEME_COOKIE, value);
}
