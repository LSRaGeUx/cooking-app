"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

type Mode = "login" | "signup";

/**
 * Sign-in and sign-up in one form, because they differ by one field and one
 * endpoint, and switching between them must not navigate.
 *
 * Two things drive that design. First, it posts to the auth HTTP API from the
 * browser rather than through a server action, because when the user arrived
 * from an OAuth authorization request the original query is HMAC-signed and has
 * to be handed back byte for byte: `window.location.search` is the only source
 * guaranteed untouched, and anything that parses and re-serializes it breaks the
 * signature so the MCP client never gets its token (see
 * docs/07-phase-0-findings.md section 2.6). Second, the switch between login and
 * sign-up is local state rather than a link, for the same reason: a rebuilt
 * query is a broken query, and a new user connecting an agent needs to be able
 * to create an account without leaving this URL.
 *
 * The auth plugin then resumes the authorization flow itself and answers with
 * the URL to continue to.
 */
export function CredentialsForm({ initialMode }: { initialMode: Mode }) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const t = useTranslations(mode);
  const common = useTranslations("common");
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setFailed(false);

    const oauthQuery = window.location.search.replace(/^\?/, "");
    const endpoint =
      mode === "login" ? "/api/auth/sign-in/email" : "/api/auth/sign-up/email";

    const body: Record<string, unknown> = {
      email: String(form.get("email") ?? ""),
      password: String(form.get("password") ?? ""),
    };
    if (mode === "signup") body.name = String(form.get("name") ?? "");
    if (oauthQuery) body.oauth_query = oauthQuery;

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        setFailed(true);
        setPending(false);
        return;
      }

      const payload: unknown = await response.json().catch(() => null);
      const target = redirectTargetOf(payload);
      if (target) {
        window.location.href = target;
        return;
      }

      router.replace("/");
      router.refresh();
    } catch {
      setFailed(true);
      setPending(false);
    }
  }

  const fieldClass =
    "rounded-md border border-black/15 px-3 py-2 dark:border-white/20";

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={onSubmit} className="flex flex-col gap-4">
        {mode === "signup" ? (
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{t("name")}</span>
            <input
              name="name"
              type="text"
              required
              autoComplete="name"
              className={fieldClass}
            />
          </label>
        ) : null}

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{t("email")}</span>
          <input
            name="email"
            type="email"
            required
            autoComplete="email"
            className={fieldClass}
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{t("password")}</span>
          <input
            name="password"
            type="password"
            required
            minLength={8}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            className={fieldClass}
          />
          {mode === "signup" ? (
            <span className="text-xs opacity-70">{t("passwordHint")}</span>
          ) : null}
        </label>

        {failed ? (
          <p role="alert" className="text-sm text-red-700 dark:text-red-400">
            {t("failed")}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-60 dark:bg-white dark:text-black"
        >
          {pending ? t("submitting") : t("submit")}
        </button>

        <p className="sr-only" aria-live="polite">
          {pending ? common("loading") : ""}
        </p>
      </form>

      <p className="text-sm opacity-70">
        {mode === "login" ? t("noAccount") : t("hasAccount")}{" "}
        <button
          type="button"
          className="underline"
          onClick={() => {
            setFailed(false);
            setMode(mode === "login" ? "signup" : "login");
          }}
        >
          {mode === "login" ? t("signUpLink") : t("loginLink")}
        </button>
      </p>
    </div>
  );
}

/**
 * The auth API answers a resumed authorization request with a redirect
 * descriptor rather than a 302, because the caller is fetch and not a
 * navigation. Both spellings are accepted so a library rename cannot silently
 * strand a user on the login screen.
 */
function redirectTargetOf(payload: unknown): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const candidate = record.url ?? record.redirect_uri ?? record.redirectURI;
  return typeof candidate === "string" && candidate.length > 0
    ? candidate
    : null;
}
