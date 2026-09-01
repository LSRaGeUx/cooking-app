"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { isTheme, THEME_COOKIE } from "@/lib/theme";

/**
 * The theme is a browser preference, not account data: it needs no session and
 * touches nothing owned by a user. Same shape as the locale action, on purpose.
 */
export async function setThemeAction(value: string): Promise<void> {
  if (!isTheme(value)) return;

  const store = await cookies();
  store.set(THEME_COOKIE, value, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
  });

  // The ground colour is rendered on the html element, so the tree is stale.
  revalidatePath("/", "layout");
}
