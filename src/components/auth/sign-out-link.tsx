"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { signOut } from "@/lib/sign-out";

/**
 * The way out for someone whose address was dropped from the allowlist.
 *
 * They still hold a valid session cookie, so every page bounces them here, and
 * the ordinary sign-out lives in the app navigation behind exactly the pages
 * they can no longer reach. Without this they cannot even sign in as somebody
 * else without clearing site data by hand.
 */
export function SignOutLink() {
  const t = useTranslations("login");
  const router = useRouter();
  const [pending, setPending] = useState(false);

  // One implementation, shared with the application navigation. It also drops
  // the offline grocery cache, which otherwise survives a sign-out.
  function onSignOut(): void {
    setPending(true);
    void signOut()
      .then(() => {
        router.replace("/login");
        router.refresh();
      })
      .catch((error: unknown) => {
        console.error("Sign out did not complete", error);
        setPending(false);
      });
  }

  return (
    <button
      type="button"
      onClick={onSignOut}
      disabled={pending}
      className="link self-start text-sm"
    >
      {pending ? t("signOutPending") : t("signOutToSwitch")}
    </button>
  );
}
