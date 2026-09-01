"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

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

  async function signOut(): Promise<void> {
    setPending(true);
    // The body and its content type are not optional: the endpoint declares the
    // media types it accepts and answers 415 to a POST that names none.
    await fetch("/api/auth/sign-out", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    router.replace("/login");
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={signOut}
      disabled={pending}
      className="link self-start text-sm"
    >
      {pending ? t("signOutPending") : t("signOutToSwitch")}
    </button>
  );
}
