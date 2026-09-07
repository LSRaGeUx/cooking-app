"use server";

import { isLocale, LOCALE_COOKIE } from "@/i18n/config";
import { setPreferenceCookie } from "./preference-cookie";

/**
 * The locale is a browser preference, not account data: it needs no session and
 * touches nothing owned by a user. The cookie itself is written by
 * `setPreferenceCookie`, which the theme action shares.
 */
export async function setLocaleAction(value: string): Promise<void> {
  if (!isLocale(value)) return;
  await setPreferenceCookie(LOCALE_COOKIE, value);
}
