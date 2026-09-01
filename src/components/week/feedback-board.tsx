"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  applyBudgetSuggestionAction,
  clearFeedbackAction,
  recordFeedbackAction,
} from "@/app/actions/feedback-actions";
import { Feedback, type FeedbackState } from "@/components/feedback";
import { FEEDBACK_OUTCOMES, PORTION_ISSUES } from "@/domain/vocabulary";
import type { IsoWeek } from "@/domain/week";
import type { FeedbackView } from "@/services/feedback-service";
import type { BudgetSuggestion, UnresolvedSignal } from "@/domain/signals";

/**
 * The batch fill screen: a whole past week in one place.
 *
 * Everything except the outcome is optional, and a meal can be left blank. A
 * form that demands a rating and a note for seven meals is a form nobody fills
 * twice, and an unanswered prompt teaches the system nothing at all.
 */

export interface FeedbackRow {
  readonly entryId: string;
  readonly dayOfWeek: number;
  readonly mealTypeLabel: string;
  readonly recipeTitle: string;
  readonly feedback: FeedbackView | null;
}

export function FeedbackBoard({
  week,
  rows,
  signals,
  suggestions,
}: {
  week: IsoWeek;
  rows: readonly FeedbackRow[];
  signals: readonly UnresolvedSignal[];
  suggestions: readonly BudgetSuggestion[];
}) {
  const t = useTranslations("feedback");
  const days = useTranslations("week.days");
  const common = useTranslations("common");
  const router = useRouter();

  const [feedbackState, setFeedbackState] = useState<FeedbackState>({});
  const [pending, setPending] = useState(false);

  async function run(
    action: () => Promise<{
      ok: boolean;
      code?: string;
      message?: string;
      details?: Record<string, unknown>;
    }>,
  ): Promise<void> {
    setPending(true);
    const result = await action();
    setPending(false);
    if (!result.ok) {
      setFeedbackState({
        error: {
          code: result.code ?? "INTERNAL",
          message: result.message ?? "",
          details: result.details,
        },
      });
      return;
    }
    setFeedbackState({});
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-5">
      <Feedback {...feedbackState} />

      {rows.length === 0 ? (
        <p className="hint">{t("empty")}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((row) => (
            <FeedbackRowForm
              key={row.entryId}
              week={week}
              row={row}
              disabled={pending}
              dayLabel={days(String(row.dayOfWeek))}
              onRun={run}
            />
          ))}
        </ul>
      )}

      <section className="flex flex-col gap-3 border-t border-rule pt-6">
        <h2 className="eyebrow eyebrow-rule">{t("signals")}</h2>
        <p className="hint">{t("signalsHelp")}</p>

        {signals.length === 0 && suggestions.length === 0 ? (
          <p className="hint">{t("noSignals")}</p>
        ) : null}

        {signals.length > 0 ? (
          <ul className="ruled flex flex-col text-sm">
            {signals.map((signal, index) => (
              <li key={`${signal.code}-${index}`} className="py-2">
                {signal.message}
              </li>
            ))}
          </ul>
        ) : null}

        {suggestions.map((suggestion) => (
          <div
            key={`${suggestion.dayOfWeek}:${suggestion.mealTypeId}`}
            className="banner banner-warn"
          >
            <span>
              {t("budgetSuggestion", {
                day: days(String(suggestion.dayOfWeek)),
                meal: suggestion.mealTypeLabel.toLowerCase(),
                overruns: `${suggestion.overrunCount}/${suggestion.observedCount}`,
                current: suggestion.currentBudgetMin,
                suggested: suggestion.suggestedBudgetMin,
              })}
            </span>
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                void run(() =>
                  applyBudgetSuggestionAction(
                    suggestion.dayOfWeek,
                    suggestion.mealTypeId,
                    suggestion.suggestedBudgetMin,
                    null,
                  ),
                )
              }
              className="btn btn-quiet btn-sm ml-auto"
            >
              {t("budgetApply")}
            </button>
          </div>
        ))}
      </section>

      <p className="sr-only" aria-live="polite">
        {pending ? common("saving") : ""}
      </p>
    </div>
  );
}

function FeedbackRowForm({
  week,
  row,
  dayLabel,
  disabled,
  onRun,
}: {
  week: IsoWeek;
  row: FeedbackRow;
  dayLabel: string;
  disabled: boolean;
  onRun: (
    action: () => Promise<{
      ok: boolean;
      code?: string;
      message?: string;
      details?: Record<string, unknown>;
    }>,
  ) => Promise<void>;
}) {
  const t = useTranslations("feedback");
  const common = useTranslations("common");

  const [outcome, setOutcome] = useState(row.feedback?.outcome ?? "");
  const [swappedFor, setSwappedFor] = useState(row.feedback?.swappedFor ?? "");
  const [rating, setRating] = useState(
    row.feedback?.rating === null || row.feedback?.rating === undefined
      ? ""
      : String(row.feedback.rating),
  );
  const [note, setNote] = useState(row.feedback?.note ?? "");
  const [tookLonger, setTookLonger] = useState(row.feedback?.tookLonger ?? false);
  const [portionIssue, setPortionIssue] = useState(
    row.feedback?.portionIssue ?? "",
  );

  return (
    <li
      className={`slip flex flex-col gap-3 border-l-[3px] p-4 ${
        row.feedback === null ? "border-l-rule-strong" : "border-l-olive"
      }`}
    >
      <div className="flex flex-wrap items-baseline gap-2.5">
        <span className="display text-base">{row.recipeTitle}</span>
        <span className="eyebrow">
          {dayLabel} {row.mealTypeLabel.toLowerCase()}
        </span>
        {row.feedback === null ? (
          <span className="chip">{t("notAnswered")}</span>
        ) : null}
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="label">
          <span>{t("outcome")}</span>
          <select
            value={outcome}
            onChange={(event) => setOutcome(event.target.value)}
            className="field"
          >
            <option value="">{common("none")}</option>
            {FEEDBACK_OUTCOMES.map((value) => (
              <option key={value} value={value}>
                {t(`outcomes.${value}`)}
              </option>
            ))}
          </select>
        </label>

        {outcome === "swapped" ? (
          <label className="label min-w-[10rem] flex-1">
            <span>{t("swappedFor")}</span>
            <input
              value={swappedFor}
              placeholder={t("swappedForPlaceholder")}
              onChange={(event) => setSwappedFor(event.target.value)}
              className="field"
            />
          </label>
        ) : null}

        <label className="label">
          <span>{t("rating")}</span>
          <select
            value={rating}
            onChange={(event) => setRating(event.target.value)}
            className="field"
          >
            <option value="">{common("none")}</option>
            {[1, 2, 3, 4, 5].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>

        <label className="label">
          <span>{t("portionIssue")}</span>
          <select
            value={portionIssue}
            onChange={(event) => setPortionIssue(event.target.value)}
            className="field"
          >
            <option value="">{t("portions.none")}</option>
            {PORTION_ISSUES.map((value) => (
              <option key={value} value={value}>
                {t(`portions.${value}`)}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 py-1 text-sm">
          <input
            type="checkbox"
            checked={tookLonger}
            onChange={(event) => setTookLonger(event.target.checked)}
          />
          <span>{t("tookLonger")}</span>
        </label>
      </div>

      <label className="label">
        <span>{t("note")}</span>
        <input
          value={note}
          placeholder={t("notePlaceholder")}
          onChange={(event) => setNote(event.target.value)}
          className="field"
        />
      </label>

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          disabled={disabled || outcome === ""}
          onClick={() =>
            void onRun(() =>
              recordFeedbackAction(week, row.entryId, {
                outcome,
                swappedFor: swappedFor.trim() || null,
                rating: rating === "" ? null : Number(rating),
                note: note.trim() || null,
                tookLonger,
                portionIssue: portionIssue === "" ? null : portionIssue,
              }),
            )
          }
          className="btn btn-primary btn-sm"
        >
          {t("save")}
        </button>

        {row.feedback ? (
          <button
            type="button"
            disabled={disabled}
            onClick={() => void onRun(() => clearFeedbackAction(week, row.entryId))}
            className="btn btn-ghost btn-sm"
          >
            {t("clear")}
          </button>
        ) : null}
      </div>
    </li>
  );
}
