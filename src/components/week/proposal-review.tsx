"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  acceptProposalAction,
  acceptProposalEntriesAction,
  rejectProposalAction,
} from "@/app/actions/proposal-actions";
import { Feedback, type FeedbackState } from "@/components/feedback";
import type { IsoWeek } from "@/domain/week";
import type { ProposalReview } from "@/services/plan-service";

/**
 * The screen where a proposal becomes a plan, or does not.
 *
 * It shows a diff rather than a list, because a list of seven dishes says
 * nothing about what would change. It shows the rationale under each dish, with
 * the cited facts as links, because the entire argument for demanding a
 * rationale is that the user can then correct the reason instead of the dish.
 * And rejecting asks for a reason, because that sentence is the best signal
 * this product ever gets.
 */
export function ProposalReviewPanel({
  week,
  review,
  weekHref,
}: {
  week: IsoWeek;
  review: ProposalReview;
  weekHref: string;
}) {
  const t = useTranslations("proposal");
  const days = useTranslations("week.days");
  const common = useTranslations("common");
  const router = useRouter();

  const acceptable = review.rows.filter((row) => row.proposed !== null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(acceptable.map((row) => row.proposed!.id)),
  );
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackState>({});

  async function run(
    action: () => Promise<{ ok: boolean; code?: string; message?: string }>,
  ): Promise<void> {
    setPending(true);
    const result = await action();
    setPending(false);
    if (!result.ok) {
      setFeedback({
        error: { code: result.code ?? "INTERNAL", message: result.message ?? "" },
      });
      return;
    }
    router.push(weekHref);
    router.refresh();
  }

  function toggle(entryId: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(entryId)) next.delete(entryId);
      else next.add(entryId);
      return next;
    });
  }

  const statusLabel: Record<string, string> = {
    added: t("statusAdded"),
    changed: t("statusChanged"),
    removed: t("statusRemoved"),
    unchanged: t("statusUnchanged"),
  };

  const statusClass: Record<string, string> = {
    added: "border-emerald-600/50 bg-emerald-500/5",
    changed: "border-amber-500/50 bg-amber-500/5",
    removed: "border-red-500/40 bg-red-500/5",
    unchanged: "border-black/10 dark:border-white/15",
  };

  return (
    <div className="flex flex-col gap-5">
      <Feedback {...feedback} />

      {review.version.summary ? (
        <section className="flex flex-col gap-1 rounded-md border border-black/10 p-3 dark:border-white/15">
          <h2 className="text-sm font-medium">{t("summary")}</h2>
          <p className="text-sm opacity-80">{review.version.summary}</p>
        </section>
      ) : null}

      <ul className="flex flex-col gap-2">
        {review.rows.map((row) => {
          const entryId = row.proposed?.id ?? null;
          return (
            <li
              key={`${row.dayOfWeek}:${row.mealTypeId}`}
              className={`flex flex-col gap-2 rounded-md border p-3 ${statusClass[row.status]}`}
            >
              <div className="flex flex-wrap items-baseline gap-2">
                {entryId ? (
                  <input
                    type="checkbox"
                    checked={selected.has(entryId)}
                    onChange={() => toggle(entryId)}
                    aria-label={`${days(String(row.dayOfWeek))} ${row.mealTypeLabel}`}
                    className="h-4 w-4"
                  />
                ) : null}
                <span className="text-sm font-medium">
                  {days(String(row.dayOfWeek))} {row.mealTypeLabel.toLowerCase()}
                </span>
                <span className="rounded bg-black/5 px-1.5 py-0.5 text-xs dark:bg-white/10">
                  {statusLabel[row.status]}
                </span>
              </div>

              <div className="flex flex-col gap-0.5 text-sm">
                <span className="font-medium">
                  {row.proposed
                    ? `${row.proposed.recipeTitleSnapshot} · ${common("servings", { count: row.proposed.servings })}`
                    : t("proposedEmpty")}
                </span>
                <span className="text-xs opacity-60">
                  {row.current
                    ? t("currentlyPlanned", { title: row.current.recipeTitleSnapshot })
                    : t("currentlyEmpty")}
                </span>
                {row.proposed?.note ? (
                  <span className="text-xs italic opacity-70">
                    {row.proposed.note}
                  </span>
                ) : null}
              </div>

              {row.proposed ? (
                <div className="flex flex-col gap-1 border-t border-black/10 pt-2 dark:border-white/15">
                  <span className="text-xs font-medium uppercase tracking-wide opacity-60">
                    {t("rationale")}
                  </span>
                  <p className="text-sm opacity-90">
                    {row.proposed.rationale ?? t("noRationale")}
                  </p>
                  {row.citedFacts.length > 0 ? (
                    <ul className="flex flex-wrap gap-2 pt-1">
                      {row.citedFacts.map((cited) => (
                        <li key={cited.id}>
                          <Link
                            href="/faits"
                            className="rounded bg-black/5 px-1.5 py-0.5 text-xs underline dark:bg-white/10"
                          >
                            {cited.statement}
                            {cited.status === "unconfirmed"
                              ? ` (${t("factUnconfirmed")})`
                              : ""}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      <div className="flex flex-wrap items-center gap-3 border-t border-black/10 pt-4 dark:border-white/15">
        <button
          type="button"
          disabled={pending}
          onClick={() => void run(() => acceptProposalAction(week))}
          className="rounded-md bg-black px-4 py-2 text-sm font-medium text-white disabled:opacity-60 dark:bg-white dark:text-black"
        >
          {pending ? t("working") : t("acceptAll")}
        </button>

        <button
          type="button"
          disabled={pending || selected.size === 0 || selected.size === acceptable.length}
          onClick={() =>
            void run(() => acceptProposalEntriesAction(week, [...selected]))
          }
          className="rounded-md border border-black/15 px-4 py-2 text-sm disabled:opacity-40 dark:border-white/20"
        >
          {t("acceptSelected", { count: selected.size })}
        </button>

        <button
          type="button"
          disabled={pending}
          onClick={() => setRejecting(!rejecting)}
          className="text-sm text-red-700 underline disabled:opacity-40 dark:text-red-400"
        >
          {t("reject")}
        </button>

        <button
          type="button"
          onClick={() =>
            setSelected(
              selected.size === acceptable.length
                ? new Set()
                : new Set(acceptable.map((row) => row.proposed!.id)),
            )
          }
          className="text-xs underline opacity-60"
        >
          {selected.size === acceptable.length ? t("selectNone") : t("selectAll")}
        </button>
      </div>

      <p className="text-xs opacity-70">{t("acceptSelectedHelp")}</p>

      {rejecting ? (
        <section className="flex flex-col gap-2 rounded-md border border-red-500/40 p-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="font-medium">{t("rejectReason")}</span>
            <textarea
              rows={2}
              value={reason}
              placeholder={t("rejectReasonPlaceholder")}
              onChange={(event) => setReason(event.target.value)}
              className="rounded-md border border-black/15 px-3 py-2 dark:border-white/20"
            />
            <span className="text-xs opacity-70">{t("rejectReasonHelp")}</span>
          </label>
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              void run(() =>
                rejectProposalAction(week, reason.trim() || null),
              )
            }
            className="self-start rounded-md border border-red-500/50 px-3 py-1.5 text-sm text-red-700 disabled:opacity-40 dark:text-red-400"
          >
            {t("rejectSubmit")}
          </button>
        </section>
      ) : null}
    </div>
  );
}
