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
 *
 * Provenance is drawn, not written: a fact the agent proposed carries a woad
 * edge until a human confirms it, and then the edge turns olive. Across the app
 * those two colours never mean anything else, so "who claimed this" is legible
 * before the sentence is read.
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
    action: () => Promise<{
      ok: boolean;
      code?: string;
      message?: string;
      details?: Record<string, unknown>;
    }>,
  ): Promise<boolean> {
    setPending(true);
    const result = await action();
    setPending(false);
    if (!result.ok) {
      setFeedback({
        error: {
          code: result.code ?? "INTERNAL",
          message: result.message ?? "",
          details: result.details,
        },
      });
      return false;
    }
    setFeedback({});
    router.refresh();
    return true;
  }

  return (
    <div className="flex flex-col gap-7">
      <Feedback {...feedback} />

      {/* How full the dossier is, because the cap is a real constraint. */}
      <div className="flex flex-col gap-3 border-y border-rule py-5">
        <div className="flex flex-wrap items-baseline gap-4">
          <span aria-hidden="true" className="numeral text-5xl">
            {activeCount}
            <span className="text-faint">/{cap}</span>
          </span>
          <span className="sr-only">{t("count", { active: activeCount, cap })}</span>
          {unconfirmed > 0 ? (
            <span className="chip chip-agent">
              {t("unconfirmedBanner", { count: unconfirmed })}
            </span>
          ) : null}
        </div>
        <div className="h-[3px] w-full max-w-md bg-rule" aria-hidden="true">
          <div
            className="h-full bg-olive"
            style={{ width: `${Math.min((activeCount / cap) * 100, 100)}%` }}
          />
        </div>
      </div>

      <form className="flex flex-wrap items-end gap-3" method="get">
        <label className="label">
          <span>{t("filterCategory")}</span>
          <select name="category" defaultValue={filter.category ?? ""} className="field">
            <option value="">{t("filterAll")}</option>
            {FACT_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {t(`categories.${category}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="label">
          <span>{t("filterStatus")}</span>
          <select name="status" defaultValue={filter.status ?? ""} className="field">
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
        <button type="submit" className="btn btn-quiet">
          {common("search")}
        </button>
      </form>

      {facts.length === 0 ? (
        <p className="hint">
          {filter.category || filter.status ? t("emptyFiltered") : t("empty")}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {facts.map((fact, index) => (
            <li
              key={fact.id}
              className={`slip flex flex-col gap-2.5 border-l-[3px] p-4 ${
                fact.status === "unconfirmed"
                  ? "border-l-agent bg-agent-soft"
                  : fact.status === "retired"
                    ? "border-l-rule-strong opacity-60"
                    : "border-l-olive"
              }`}
            >
              {/*
                A fact is a claim about the reader, so it is set like one: at
                the size of a pull quote, with its index in the margin. This
                screen is the trust surface, and nothing on it should look like
                a table row.
              */}
              <div className="flex gap-4">
                <span
                  aria-hidden="true"
                  className="micro pt-1.5 tabular-nums"
                >
                  {String(index + 1).padStart(2, "0")}
                </span>
                <p
                  className={`display flex-1 text-[1.4rem] leading-snug ${
                    fact.status === "retired" ? "line-through" : ""
                  }`}
                >
                  {fact.statement}
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <span className="chip">{t(`categories.${fact.category}`)}</span>
                <span className="chip">{t(`polarities.${fact.polarity}`)}</span>
                <span className="chip">{t(`confidences.${fact.confidence}`)}</span>
                <span
                  className={`chip ${
                    fact.status === "unconfirmed"
                      ? "chip-agent"
                      : fact.status === "confirmed"
                        ? "chip-ok"
                        : ""
                  }`}
                >
                  {t(`statuses.${fact.status}`)}
                </span>
                <span className="micro ml-1">
                  {t("writtenBy", { source: t(`sources.${fact.source}`) })}
                </span>
                {fact.supersedesId ? (
                  <span className="micro">{t("supersedes")}</span>
                ) : null}
              </div>

              {fact.retirementReason ? (
                <p className="hint">
                  {t("retirementReason", { reason: fact.retirementReason })}
                </p>
              ) : null}

              {fact.status !== "retired" ? (
                <div className="flex flex-wrap items-center gap-2 border-t border-rule pt-2.5">
                  {fact.status === "unconfirmed" ? (
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => void run(() => confirmFactAction(fact.id))}
                      className="btn btn-primary btn-sm"
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
                    className="btn btn-ghost btn-sm"
                  >
                    {t("replace")}
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => void run(() => retireFactAction(fact.id))}
                    className="btn btn-ghost btn-sm"
                  >
                    {t("retire")}
                  </button>
                </div>
              ) : null}

              {replacing === fact.id ? (
                <div className="flex flex-col gap-3 border-t border-rule pt-3">
                  <p className="hint">{t("replaceHelp")}</p>
                  <DraftFields draft={replacement} onChange={setReplacement} />
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
                    className="btn btn-primary btn-sm self-start"
                  >
                    {t("replaceSubmit")}
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <section className="flex flex-col gap-3 border-t border-rule pt-6">
        <h2 className="eyebrow eyebrow-rule">{t("add")}</h2>
        <DraftFields draft={draft} onChange={setDraft} />
        <button
          type="button"
          disabled={pending || draft.statement.trim().length === 0}
          onClick={async () => {
            const ok = await run(() =>
              createFactAction({ ...draft, statement: draft.statement.trim() }),
            );
            if (ok) setDraft(EMPTY_DRAFT);
          }}
          className="btn btn-primary self-start"
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
}: {
  draft: FactDraft;
  onChange: (draft: FactDraft) => void;
}) {
  const t = useTranslations("facts");
  const remaining = FACT_STATEMENT_MAX_LENGTH - draft.statement.length;

  return (
    <div className="flex flex-col gap-3">
      <label className="label">
        <span>{t("statement")}</span>
        <input
          value={draft.statement}
          maxLength={FACT_STATEMENT_MAX_LENGTH}
          onChange={(event) =>
            onChange({ ...draft, statement: event.target.value })
          }
          className="field"
        />
        <span className="hint">
          {t("statementHelp")}{" "}
          <span className="micro">
            {t("statementRemaining", { count: remaining })}
          </span>
        </span>
      </label>

      <div className="flex flex-wrap gap-3">
        <label className="label">
          <span>{t("category")}</span>
          <select
            value={draft.category}
            onChange={(event) => onChange({ ...draft, category: event.target.value })}
            className="field"
          >
            {FACT_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {t(`categories.${category}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="label">
          <span>{t("polarity")}</span>
          <select
            value={draft.polarity}
            onChange={(event) => onChange({ ...draft, polarity: event.target.value })}
            className="field"
          >
            {FACT_POLARITIES.map((polarity) => (
              <option key={polarity} value={polarity}>
                {t(`polarities.${polarity}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="label">
          <span>{t("confidence")}</span>
          <select
            value={draft.confidence}
            onChange={(event) =>
              onChange({ ...draft, confidence: event.target.value })
            }
            className="field"
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
