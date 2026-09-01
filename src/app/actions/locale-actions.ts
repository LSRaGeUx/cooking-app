"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { isLocale, LOCALE_COOKIE } from "@/i18n/config";

/**
 * The locale is a browser preference, not account data: it needs no session and
 * touches nothing owned by a user.
 */
export async function setLocaleAction(value: string): Promise<void> {
  if (!isLocale(value)) return;

  const store = await cookies();
  store.set(LOCALE_COOKIE, value, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
  });

  // Every rendered page holds translated strings, so the whole tree is stale.
  revalidatePath("/", "layout");
}
