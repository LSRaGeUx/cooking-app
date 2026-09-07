import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";

/**
 * The one implementation behind the locale and theme actions, which were two
 * identical files differing only in a cookie name and a validator.
 *
 * Deliberately **not** a `"use server"` module. Every export of one of those is
 * a public POST endpoint, and an endpoint taking a cookie name and a value from
 * the caller is a way to overwrite any cookie on the origin, session included.
 * It is a plain server-only helper that the two actions call after they have
 * validated the value against their own vocabulary.
 *
 * `httpOnly` and `secure` are both set, which they were not. Nothing in the
 * browser reads either cookie: both are resolved on the server so the first
 * byte carries the right language and the right ground, which is the whole
 * reason they are cookies rather than localStorage. A preference cookie
 * readable by script is one any script on the page can read or rewrite.
 *
 * A year of `maxAge`, and `sameSite: "lax"` so following a link into the
 * application still arrives in the chosen language.
 */
export async function setPreferenceCookie(
  name: string,
  value: string,
): Promise<void> {
  const store = await cookies();
  store.set(name, value, {
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
    sameSite: "lax",
    httpOnly: true,
    secure: true,
  });

  // Every rendered page holds translated strings and the ground colour is on
  // the html element, so either change makes the whole tree stale.
  revalidatePath("/", "layout");
}
