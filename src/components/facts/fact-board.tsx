"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  confirmFactAction,
  createFactAction,
  retireFactAction,
  supersedeFactAction,
} from "@/app/actions/fact-actions";
import { Feedback, type FeedbackState } from "@/components/feedback";
import {
  FACT_CATEGORIES,
  FACT_CONFIDENCES,
  FACT_POLARITIES,
  FACT_STATEMENT_MAX_LENGTH,
} from "@/domain/vocabulary";
import type { FactView } from "@/services/fact-service";

/**
 * The trust surface of the product.
 *
 * Unconfirmed facts come first because they are what the user came here to
 * review, and every claim shows who wrote it. Nothing on this screen edits a
 * statement in place: changing what a fact says goes through "replace", which
 * retires the old row and keeps the link, so a taste that changed stays
 * legible instead of being quietly overwritten.
 */

interface FactDraft {
  statement: string;
  category: string;
  polarity: string;
  confidence: string;
}

const EMPTY_DRAFT: FactDraft = {
  statement: "",
  category: "taste",
  polarity: "neutral",
  confidence: "medium",
};

export function FactBoard({
  facts,
  activeCount,
  cap,
  filter,
}: {
  facts: readonly FactView[];
  activeCount: number;
  cap: number;
  filter: { category?: string; status?: string; includeRetired: boolean };
}) {
  const t = useTranslations("facts");
  const common = useTranslations("common");
  const router = useRouter();

  const [feedback, setFeedback] = useState<FeedbackState>({});
  const [pending, setPending] = useState(false);
  const [draft, setDraft] = useState<FactDraft>(EMPTY_DRAFT);
  const [replacing, setReplacing] = useState<string | null>(null);
  const [replacement, setReplacement] = useState<FactDraft>(EMPTY_DRAFT);

  const unconfirmed = facts.filter((row) => row.status === "unconfirmed").length;

  async function run(
    action: () => Promise<{ ok: boolean; code?: string; message?: string }>,
  ): Promise<boolean> {
    setPending(true);
    const result = await action();
    setPending(false);
    if (!result.ok) {
      setFeedback({
        error: { code: result.code ?? "INTERNAL", message: result.message ?? "" },
      });
      return false;
    }
    setFeedback({});
    router.refresh();
    return true;
  }

  const field =
    "rounded-md border border-black/15 px-3 py-2 text-sm dark:border-white/20";

  return (
    <div className="flex flex-col gap-6">
      <Feedback {...feedback} />

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="opacity-70">{t("count", { active: activeCount, cap })}</span>
        {unconfirmed > 0 ? (
          <span className="rounded-md border border-amber-500/40 px-2 py-1 text-xs">
            {t("unconfirmedBanner", { count: unconfirmed })}
          </span>
        ) : null}
      </div>

      <form className="flex flex-wrap items-end gap-2" method="get">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{t("filterCategory")}</span>
          <select name="category" defaultValue={filter.category ?? ""} className={field}>
            <option value="">{t("filterAll")}</option>
            {FACT_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {t(`categories.${category}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{t("filterStatus")}</span>
          <select name="status" defaultValue={filter.status ?? ""} className={field}>
            <option value="">{t("filterAll")}</option>
            <option value="unconfirmed">{t("statuses.unconfirmed")}</option>
            <option value="confirmed">{t("statuses.confirmed")}</option>
          </select>
        </label>
        <label className="flex items-center gap-2 py-2 text-sm">
          <input
            type="checkbox"
            name="retired"
            value="1"
            defaultChecked={filter.includeRetired}
          />
          <span>{t("showRetired")}</span>
        </label>
        <button
          type="submit"
          className="rounded-md border border-black/15 px-3 py-2 text-sm dark:border-white/20"
        >
          {common("search")}
        </button>
      </form>

      {facts.length === 0 ? (
        <p className="text-sm opacity-70">
          {filter.category || filter.status ? t("emptyFiltered") : t("empty")}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {facts.map((fact) => (
            <li
              key={fact.id}
              className={`flex flex-col gap-2 rounded-md border px-3 py-2 ${
                fact.status === "unconfirmed"
                  ? "border-amber-500/40 bg-amber-500/5"
                  : fact.status === "retired"
                    ? "border-black/10 opacity-60 dark:border-white/10"
                    : "border-black/15 dark:border-white/20"
              }`}
            >
              <div className="flex flex-wrap items-baseline gap-2">
                <span
                  className={`text-sm ${fact.status === "retired" ? "line-through" : ""}`}
                >
                  {fact.statement}
                </span>
                <span className="text-xs opacity-60">
                  {t(`categories.${fact.category}`)} ·{" "}
                  {t(`polarities.${fact.polarity}`)} ·{" "}
                  {t(`confidences.${fact.confidence}`)} ·{" "}
                  {t(`statuses.${fact.status}`)}
                </span>
                <span className="text-xs opacity-50">
                  {t("writtenBy", { source: t(`sources.${fact.source}`) })}
                </span>
                {fact.supersedesId ? (
                  <span className="text-xs opacity-50">{t("supersedes")}</span>
                ) : null}
              </div>

              {fact.status !== "retired" ? (
                <div className="flex flex-wrap gap-3 text-xs">
                  {fact.status === "unconfirmed" ? (
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => void run(() => confirmFactAction(fact.id))}
                      className="underline disabled:opacity-40"
                    >
                      {t("confirm")}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => {
                      setReplacing(replacing === fact.id ? null : fact.id);
                      setReplacement({
                        statement: fact.statement,
                        category: fact.category,
                        polarity: fact.polarity,
                        confidence: fact.confidence,
                      });
                    }}
                    className="underline disabled:opacity-40"
                  >
                    {t("replace")}
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => void run(() => retireFactAction(fact.id))}
                    className="underline disabled:opacity-40"
                  >
                    {t("retire")}
                  </button>
                </div>
              ) : null}

              {replacing === fact.id ? (
                <div className="flex flex-col gap-2 border-t border-black/10 pt-2 dark:border-white/15">
                  <p className="text-xs opacity-70">{t("replaceHelp")}</p>
                  <DraftFields
                    draft={replacement}
                    onChange={setReplacement}
                    field={field}
                  />
                  <button
                    type="button"
                    disabled={pending || replacement.statement.trim().length === 0}
                    onClick={async () => {
                      const ok = await run(() =>
                        supersedeFactAction(fact.id, {
                          ...replacement,
                          statement: replacement.statement.trim(),
                        }),
                      );
                      if (ok) setReplacing(null);
                    }}
                    className="self-start rounded-md bg-black px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60 dark:bg-white dark:text-black"
                  >
                    {t("replaceSubmit")}
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <section className="flex flex-col gap-2 border-t border-black/10 pt-4 dark:border-white/15">
        <h2 className="text-sm font-medium">{t("add")}</h2>
        <DraftFields draft={draft} onChange={setDraft} field={field} />
        <button
          type="button"
          disabled={pending || draft.statement.trim().length === 0}
          onClick={async () => {
            const ok = await run(() =>
              createFactAction({ ...draft, statement: draft.statement.trim() }),
            );
            if (ok) setDraft(EMPTY_DRAFT);
          }}
          className="self-start rounded-md bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-60 dark:bg-white dark:text-black"
        >
          {common("add")}
        </button>
      </section>
    </div>
  );
}

function DraftFields({
  draft,
  onChange,
  field,
}: {
  draft: FactDraft;
  onChange: (draft: FactDraft) => void;
  field: string;
}) {
  const t = useTranslations("facts");
  const remaining = FACT_STATEMENT_MAX_LENGTH - draft.statement.length;

  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">{t("statement")}</span>
        <input
          value={draft.statement}
          maxLength={FACT_STATEMENT_MAX_LENGTH}
          onChange={(event) =>
            onChange({ ...draft, statement: event.target.value })
          }
          className={`w-full ${field}`}
        />
        <span className="text-xs opacity-70">
          {t("statementHelp")} {t("statementRemaining", { count: remaining })}
        </span>
      </label>

      <div className="flex flex-wrap gap-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{t("category")}</span>
          <select
            value={draft.category}
            onChange={(event) => onChange({ ...draft, category: event.target.value })}
            className={field}
          >
            {FACT_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {t(`categories.${category}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{t("polarity")}</span>
          <select
            value={draft.polarity}
            onChange={(event) => onChange({ ...draft, polarity: event.target.value })}
            className={field}
          >
            {FACT_POLARITIES.map((polarity) => (
              <option key={polarity} value={polarity}>
                {t(`polarities.${polarity}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">{t("confidence")}</span>
          <select
            value={draft.confidence}
            onChange={(event) =>
              onChange({ ...draft, confidence: event.target.value })
            }
            className={field}
          >
            {FACT_CONFIDENCES.map((confidence) => (
              <option key={confidence} value={confidence}>
                {t(`confidences.${confidence}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}
