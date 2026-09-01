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

      {/*
        The one line the whole product depends on being pasted correctly, so it
        is given the weight of a headline rather than the weight of a field.
      */}
      <section className="flex flex-col gap-3">
        <h2 className="eyebrow eyebrow-rule">{t("endpoint")}</h2>
        <div className="flex flex-wrap items-center gap-3 rounded-[3px] border border-agent-line border-l-[3px] border-l-agent bg-sunk p-4">
          <code className="mono flex-1 overflow-x-auto text-[0.95rem] text-agent-ink">
            {endpoint}
          </code>
          <button
            type="button"
            onClick={() => void copy(endpoint)}
            className="btn btn-primary btn-sm"
          >
            {copied ? t("copied") : t("copy")}
          </button>
        </div>
        <p className="hint">{t("endpointHelp")}</p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="eyebrow eyebrow-rule">{t("instructions")}</h2>
        <div className="grid gap-3 md:grid-cols-3">
          <article className="slip flex flex-col gap-2 p-4">
            <h3 className="display text-base">{t("clientClaudeDesktop")}</h3>
            <p className="text-sm text-muted">{t("claudeDesktopSteps")}</p>
          </article>
          <article className="slip flex flex-col gap-2 p-4">
            <h3 className="display text-base">{t("clientClaudeCode")}</h3>
            <p className="text-sm text-muted">{t("claudeCodeSteps")}</p>
            <div className="mt-auto flex flex-wrap items-center gap-2 pt-2">
              <code className="flex-1 overflow-x-auto rounded-[2px] bg-sunk px-2 py-1.5 text-agent-ink">
                {claudeCodeCommand}
              </code>
              <button
                type="button"
                onClick={() => void copy(claudeCodeCommand)}
                className="btn btn-quiet btn-sm"
              >
                {t("copy")}
              </button>
            </div>
          </article>
          <article className="slip flex flex-col gap-2 p-4">
            <h3 className="display text-base">{t("clientGeneric")}</h3>
            <p className="text-sm text-muted">{t("genericSteps")}</p>
          </article>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="eyebrow eyebrow-rule">{t("test")}</h2>
        <p className={`banner ${lastCallAt ? "banner-ok" : ""}`}>
          {lastCallAt ? t("testLast", { date: lastCallAt }) : t("testNever")}
        </p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="eyebrow eyebrow-rule">{t("clients")}</h2>

        {clients.length === 0 ? (
          <p className="hint">{t("clientsEmpty")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {clients.map((client) => (
              <li
                key={client.consentId}
                className="slip flex flex-col gap-2.5 border-l-[3px] border-l-agent p-4"
              >
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="display text-base">
                    {client.name ?? client.clientId}
                  </span>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => void revoke(client.clientId)}
                    className="btn btn-danger btn-sm"
                  >
                    {t("revoke")}
                  </button>
                </div>
                <p className="micro">
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
                    <li key={scope} className="chip chip-agent">
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

        <p className="hint">{t("revokeHelp")}</p>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="eyebrow eyebrow-rule">{t("promptPack")}</h2>
        <p className="hint">{t("promptPackHelp")}</p>
        <ul className="flex flex-wrap gap-2">
          <li>
            <a href="/agent-pack/house-rules.md" className="btn btn-quiet btn-sm">
              {t("promptPackRules")}
            </a>
          </li>
          <li>
            <a href="/agent-pack/plan-week.md" className="btn btn-quiet btn-sm">
              {t("promptPackPlan")}
            </a>
          </li>
          <li>
            <a href="/agent-pack/weekly-review.md" className="btn btn-quiet btn-sm">
              {t("promptPackReview")}
            </a>
          </li>
        </ul>
      </section>
    </div>
  );
}
