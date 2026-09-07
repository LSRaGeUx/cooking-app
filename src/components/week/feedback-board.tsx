"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import {
  applyBudgetSuggestionAction,
  clearFeedbackAction,
  recordFeedbackAction,
} from "@/app/actions/feedback-actions";
import { Feedback } from "@/components/feedback";
import {
  FEEDBACK_OUTCOMES,
  PORTION_ISSUES,
  type FeedbackOutcome,
  type PortionIssue,
} from "@/domain/vocabulary";
import type { IsoWeek } from "@/domain/week";
import { useActionRunner, type ActionRunner } from "@/lib/use-action-runner";
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

  const runner = useActionRunner();
  // Which of the two things on this screen last succeeded, so the confirmation
  // says what was saved. Both messages existed in the catalogues and neither
  // was ever shown.
  const [confirmed, setConfirmed] = useState<"feedback" | "budget" | null>(
    null,
  );

  return (
    <div className="flex flex-col gap-5">
      <Feedback error={runner.feedback} warnings={runner.warnings} />

      {confirmed !== null && runner.feedback === null ? (
        <p className="banner banner-ok" aria-live="polite">
          {confirmed === "feedback" ? t("saved") : t("budgetApplied")}
        </p>
      ) : null}

      {rows.length === 0 ? (
        <p className="hint">{t("empty")}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((row) => (
            <FeedbackRowForm
              key={row.entryId}
              week={week}
              row={row}
              runner={runner}
              dayLabel={days(String(row.dayOfWeek))}
              onSaved={() => setConfirmed("feedback")}
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
              <li
                key={`${signal.code}-${index}`}
                className="flex flex-col gap-0.5 py-2"
              >
                <span className="label-text">
                  {t(`signalNames.${signal.code}`)}
                </span>
                <SignalMessage signal={signal} />
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
              disabled={runner.pending}
              onClick={() =>
                void runner.run(
                  () =>
                    /*
                     * The slot reference and the new budget, and nothing else.
                     * This used to pass a whole slot configuration, including
                     * `defaultServings: null`, which wiped whatever the slot
                     * had. The action now patches one column through the
                     * service, so accepting a suggestion cannot change the
                     * slot's state or its servings.
                     */
                    applyBudgetSuggestionAction(
                      {
                        dayOfWeek: suggestion.dayOfWeek,
                        mealTypeId: suggestion.mealTypeId,
                      },
                      suggestion.suggestedBudgetMin,
                    ),
                  { onSuccess: () => setConfirmed("budget") },
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
        {runner.pending ? common("saving") : ""}
      </p>
    </div>
  );
}

/**
 * A signal, worded in the reader's language where its details allow it.
 *
 * `SLOT_OVERRUNS` carries everything its sentence needs. The two recipe
 * signals carry an id and a count but not the title, so there is nothing to
 * build a sentence from and the service's own French sentence is shown, which
 * is the same degradation `src/lib/error-message.ts` documents for a code with
 * no template. Adding `recipeTitle` to those details is a domain change and is
 * noted as one.
 */
function SignalMessage({ signal }: { signal: UnresolvedSignal }) {
  const t = useTranslations("feedback.signalMessages");
  const days = useTranslations("week.days");

  if (signal.code === "SLOT_OVERRUNS") {
    const day = signal.details["dayOfWeek"];
    const label = signal.details["mealTypeLabel"];
    const current = signal.details["currentBudgetMin"];
    const suggested = signal.details["suggestedBudgetMin"];
    if (
      typeof day === "number" &&
      typeof label === "string" &&
      typeof current === "number" &&
      typeof suggested === "number"
    ) {
      return (
        <span>
          {t("SLOT_OVERRUNS", {
            day: days.has(String(day)) ? days(String(day)) : String(day),
            meal: label.toLowerCase(),
            current,
            suggested,
          })}
        </span>
      );
    }
  }

  return <span>{signal.message}</span>;
}

/**
 * A stored value as one of a vocabulary's members, or the empty selection.
 * Every one of these selects offers "none", so the empty string is a real
 * value here rather than a fallback that hides a mismatch.
 */
function oneOf<T extends string>(
  vocabulary: readonly T[],
  value: string | null | undefined,
): T | "" {
  if (typeof value !== "string") return "";
  return (vocabulary as readonly string[]).includes(value) ? (value as T) : "";
}

function FeedbackRowForm({
  week,
  row,
  dayLabel,
  runner,
  onSaved,
}: {
  week: IsoWeek;
  row: FeedbackRow;
  dayLabel: string;
  runner: ActionRunner;
  onSaved: () => void;
}) {
  const t = useTranslations("feedback");
  const common = useTranslations("common");

  /*
   * Narrowed rather than asserted. `FeedbackView` types both of these as
   * `string`, and a stored value the vocabulary no longer has would otherwise
   * be selected in a `<select>` that does not offer it, which renders as no
   * selection at all. Tightening the view is a service change.
   */
  const [outcome, setOutcome] = useState<FeedbackOutcome | "">(() =>
    oneOf(FEEDBACK_OUTCOMES, row.feedback?.outcome),
  );
  const [swappedFor, setSwappedFor] = useState(row.feedback?.swappedFor ?? "");
  const [rating, setRating] = useState(
    row.feedback?.rating === null || row.feedback?.rating === undefined
      ? ""
      : String(row.feedback.rating),
  );
  const [note, setNote] = useState(row.feedback?.note ?? "");
  const [tookLonger, setTookLonger] = useState(
    row.feedback?.tookLonger ?? false,
  );
  const [portionIssue, setPortionIssue] = useState<PortionIssue | "">(() =>
    oneOf(PORTION_ISSUES, row.feedback?.portionIssue),
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
            onChange={(event) =>
              setOutcome(event.target.value as FeedbackOutcome | "")
            }
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
            onChange={(event) =>
              setPortionIssue(event.target.value as PortionIssue | "")
            }
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
          disabled={runner.pending || outcome === ""}
          onClick={() =>
            void runner.run(
              () =>
                recordFeedbackAction(week, row.entryId, {
                  outcome,
                  swappedFor: swappedFor.trim() || null,
                  rating: rating === "" ? null : Number(rating),
                  note: note.trim() || null,
                  tookLonger,
                  portionIssue: portionIssue === "" ? null : portionIssue,
                }),
              { onSuccess: onSaved },
            )
          }
          className="btn btn-primary btn-sm"
        >
          {t("save")}
        </button>

        {row.feedback ? (
          <button
            type="button"
            disabled={runner.pending}
            onClick={() =>
              void runner.run(() => clearFeedbackAction(week, row.entryId))
            }
            className="btn btn-ghost btn-sm"
          >
            {t("clear")}
          </button>
        ) : null}
      </div>
    </li>
  );
}
