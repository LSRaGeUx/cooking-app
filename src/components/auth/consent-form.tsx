"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

/**
 * Accept or deny an authorization request.
 *
 * Same constraint as the login form: the signed authorization query goes back
 * to the server exactly as it arrived, read from `window.location.search`. The
 * consent endpoint verifies the signature, records the grant, and answers with
 * the URL to continue to, which carries the authorization code back to the MCP
 * client.
 */
export function ConsentForm() {
  const t = useTranslations("consent");
  const [pending, setPending] = useState<"allow" | "deny" | null>(null);
  const [failed, setFailed] = useState(false);

  async function decide(accept: boolean) {
    setPending(accept ? "allow" : "deny");
    setFailed(false);

    const oauthQuery = window.location.search.replace(/^\?/, "");

    try {
      const response = await fetch("/api/auth/oauth2/consent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accept,
          ...(oauthQuery ? { oauth_query: oauthQuery } : {}),
        }),
      });

      if (!response.ok) {
        setFailed(true);
        setPending(null);
        return;
      }

      const payload: unknown = await response.json().catch(() => null);
      const target = redirectTargetOf(payload);
      if (target) {
        window.location.href = target;
        return;
      }

      setFailed(true);
      setPending(null);
    } catch {
      setFailed(true);
      setPending(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {failed ? (
        <p role="alert" className="banner banner-danger">
          {t("failed")}
        </p>
      ) : null}

      <div className="flex gap-3">
        <button
          type="button"
          disabled={pending !== null}
          onClick={() => decide(true)}
          className="btn btn-primary flex-1"
        >
          {pending === "allow" ? t("submitting") : t("allow")}
        </button>
        <button
          type="button"
          disabled={pending !== null}
          onClick={() => decide(false)}
          className="btn btn-quiet flex-1"
        >
          {pending === "deny" ? t("submitting") : t("deny")}
        </button>
      </div>

      <p className="hint">{t("reversible")}</p>
    </div>
  );
}

function redirectTargetOf(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const candidate = record.url ?? record.redirect_uri ?? record.redirectURI;
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : null;
}
