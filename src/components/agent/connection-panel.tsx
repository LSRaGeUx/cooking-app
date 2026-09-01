"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { revokeClientAction } from "@/app/actions/agent-actions";
import { Feedback, type FeedbackState } from "@/components/feedback";
import type { ConnectedClient } from "@/services/agent-client-service";

/**
 * The screen that decides whether the product works at all.
 *
 * Everything here exists to make one paste succeed and to make the user
 * comfortable that they can undo it: the address, per-client instructions, a
 * connection test that says whether anything has actually called, and a revoke
 * button that takes effect immediately rather than at token expiry.
 */
export function ConnectionPanel({
  endpoint,
  clients,
  lastCallAt,
}: {
  endpoint: string;
  clients: readonly ConnectedClient[];
  lastCallAt: string | null;
}) {
  const locale = useLocale();
  const t = useTranslations("agent");
  const consent = useTranslations("consent");
  const router = useRouter();

  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackState>({});

  async function copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // The address is on screen and selectable; a blocked clipboard is not
      // worth an error banner.
    }
  }

  async function revoke(clientId: string): Promise<void> {
    setPending(true);
    const result = await revokeClientAction(clientId);
    setPending(false);
    if (!result.ok) {
      setFeedback({
        error: {
          code: result.code,
          message: result.message,
          details: result.details,
        },
      });
      return;
    }
    setFeedback({});
    router.refresh();
  }

  const claudeCodeCommand = `claude mcp add --transport http cooking ${endpoint}`;

  return (
    <div className="flex flex-col gap-8">
      <Feedback {...feedback} />

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium uppercase tracking-wide opacity-60">
          {t("endpoint")}
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <code className="flex-1 overflow-x-auto rounded-md border border-black/15 px-3 py-2 text-sm dark:border-white/20">
            {endpoint}
          </code>
          <button
            type="button"
            onClick={() => void copy(endpoint)}
            className="rounded-md border border-black/15 px-3 py-2 text-sm dark:border-white/20"
          >
            {copied ? t("copied") : t("copy")}
          </button>
        </div>
        <p className="max-w-2xl text-xs opacity-70">{t("endpointHelp")}</p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium uppercase tracking-wide opacity-60">
          {t("instructions")}
        </h2>
        <div className="flex flex-col gap-3">
          <article className="rounded-md border border-black/10 p-3 dark:border-white/15">
            <h3 className="text-sm font-medium">{t("clientClaudeDesktop")}</h3>
            <p className="text-sm opacity-80">{t("claudeDesktopSteps")}</p>
          </article>
          <article className="flex flex-col gap-2 rounded-md border border-black/10 p-3 dark:border-white/15">
            <h3 className="text-sm font-medium">{t("clientClaudeCode")}</h3>
            <p className="text-sm opacity-80">{t("claudeCodeSteps")}</p>
            <div className="flex flex-wrap items-center gap-2">
              <code className="flex-1 overflow-x-auto rounded-md border border-black/10 px-2 py-1 text-xs dark:border-white/15">
                {claudeCodeCommand}
              </code>
              <button
                type="button"
                onClick={() => void copy(claudeCodeCommand)}
                className="rounded-md border border-black/15 px-2 py-1 text-xs dark:border-white/20"
              >
                {t("copy")}
              </button>
            </div>
          </article>
          <article className="rounded-md border border-black/10 p-3 dark:border-white/15">
            <h3 className="text-sm font-medium">{t("clientGeneric")}</h3>
            <p className="text-sm opacity-80">{t("genericSteps")}</p>
          </article>
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium uppercase tracking-wide opacity-60">
          {t("test")}
        </h2>
        <p
          className={`rounded-md border px-3 py-2 text-sm ${
            lastCallAt
              ? "border-emerald-600/50 bg-emerald-500/5"
              : "border-black/10 dark:border-white/15"
          }`}
        >
          {lastCallAt ? t("testLast", { date: lastCallAt }) : t("testNever")}
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-medium uppercase tracking-wide opacity-60">
          {t("clients")}
        </h2>

        {clients.length === 0 ? (
          <p className="text-sm opacity-70">{t("clientsEmpty")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {clients.map((client) => (
              <li
                key={client.consentId}
                className="flex flex-col gap-2 rounded-md border border-black/15 p-3 dark:border-white/20"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">
                    {client.name ?? client.clientId}
                  </span>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => void revoke(client.clientId)}
                    className="text-sm text-red-700 underline disabled:opacity-40 dark:text-red-400"
                  >
                    {t("revoke")}
                  </button>
                </div>
                <p className="text-xs opacity-60">
                  {t("connectedAt", {
                    date: new Date(client.connectedAt).toLocaleString(locale),
                  })}
                  {" · "}
                  {client.lastSeenAt
                    ? t("lastSeen", {
                        date: new Date(client.lastSeenAt).toLocaleString(locale),
                      })
                    : t("neverSeen")}
                  {" · "}
                  {t("calls7Days", { count: client.callsLast7Days })}
                </p>
                <ul className="flex flex-wrap gap-1">
                  {client.scopes.map((scope) => (
                    <li
                      key={scope}
                      className="rounded bg-black/5 px-1.5 py-0.5 text-xs dark:bg-white/10"
                    >
                      {consent.has(`scopeNames.${scope}`)
                        ? consent(`scopeNames.${scope}`)
                        : scope}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}

        <p className="text-xs opacity-70">{t("revokeHelp")}</p>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium uppercase tracking-wide opacity-60">
          {t("promptPack")}
        </h2>
        <p className="max-w-2xl text-xs opacity-70">{t("promptPackHelp")}</p>
        <ul className="flex flex-wrap gap-3 text-sm">
          <li>
            <a href="/agent-pack/house-rules.md" className="underline">
              {t("promptPackRules")}
            </a>
          </li>
          <li>
            <a href="/agent-pack/plan-week.md" className="underline">
              {t("promptPackPlan")}
            </a>
          </li>
          <li>
            <a href="/agent-pack/weekly-review.md" className="underline">
              {t("promptPackReview")}
            </a>
          </li>
        </ul>
      </section>
    </div>
  );
}
