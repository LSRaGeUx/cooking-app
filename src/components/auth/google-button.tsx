"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

/**
 * The only door in production.
 *
 * It posts rather than links for the same reason the credentials form does: when
 * the user arrived from an MCP client's authorization request, the original
 * query is HMAC-signed and has to be handed back byte for byte, and
 * `window.location.search` is the only untouched copy of it (see
 * docs/07-phase-0-findings.md section 2.6). The OAuth provider plugin recognises
 * `oauth_query` on `/sign-in/social` specifically: it stashes the query in the
 * OAuth state, which survives the round trip to Google, and resumes the
 * authorization itself once the callback sets the session cookie.
 *
 * `errorCallbackURL` sends a refused sign-in back here with a code rather than
 * to Better Auth's built-in error page, so a person who is not on the allowlist
 * reads why in their own language.
 */
export function GoogleButton() {
  const t = useTranslations("login");
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function start() {
    setPending(true);
    setFailed(false);

    const oauthQuery = window.location.search.replace(/^\?/, "");
    const body: Record<string, unknown> = {
      provider: "google",
      callbackURL: "/",
      errorCallbackURL: "/login",
    };
    if (oauthQuery) body.oauth_query = oauthQuery;

    try {
      const response = await fetch("/api/auth/sign-in/social", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      const payload: unknown = response.ok
        ? await response.json().catch(() => null)
        : null;
      const target = authorizationUrlOf(payload);
      if (!target) {
        setFailed(true);
        setPending(false);
        return;
      }

      window.location.href = target;
    } catch {
      setFailed(true);
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <button
        type="button"
        onClick={start}
        disabled={pending}
        className="btn w-full"
      >
        <GoogleMark />
        {pending ? t("googlePending") : t("google")}
      </button>

      {failed ? (
        <p role="alert" className="banner banner-danger">
          {t("googleFailed")}
        </p>
      ) : null}
    </div>
  );
}

/** The provider answers with the URL to send the browser to, not a 302. */
function authorizationUrlOf(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const url = (payload as Record<string, unknown>).url;
  return typeof url === "string" && url.length > 0 ? url : null;
}

function GoogleMark() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 18 18"
      className="size-[1.15em] shrink-0"
      focusable="false"
    >
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.96H.96a9 9 0 0 0 0 8.08l3.01-2.32Z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.96l3.01 2.32C4.68 5.16 6.66 3.58 9 3.58Z"
      />
    </svg>
  );
}
