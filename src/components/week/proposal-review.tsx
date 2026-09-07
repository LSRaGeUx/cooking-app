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
import type { ActionResult } from "@/app/actions/result";
import { Feedback } from "@/components/feedback";
import type { IsoWeek } from "@/domain/week";
import { useActionRunner } from "@/lib/use-action-runner";
import type {
  PlanEntryView,
  ProposalReview,
  ProposalRow,
} from "@/services/plan-service";

/**
 * The screen where a proposal becomes a plan, or does not.
 *
 * It shows a diff rather than a list, because a list of seven dishes says
 * nothing about what would change. It shows the rationale under each dish, with
 * the cited facts as links, because the entire argument for demanding a
 * rationale is that the user can then correct the reason instead of the dish.
 * And rejecting asks for a reason, because that sentence is the best signal
 * this product ever gets.
 *
 * The rationale sits behind a woad edge on every row: it is the agent talking,
 * and it should never be mistaken for something the cook already decided.
 */

/** A row that actually proposes something, so it has an entry to accept. */
type AcceptableRow = ProposalRow & { proposed: PlanEntryView };

function isAcceptable(row: ProposalRow): row is AcceptableRow {
  return row.proposed !== null;
}

/**
 * The four diff outcomes a row can have. Taken from the view rather than
 * written out, so a fifth status added to the service is a compile error here
 * instead of a row with `class="undefined"` and an empty chip, which is what
 * the three `Record<string, string>` maps below used to produce: under
 * `noUncheckedIndexedAccess` a string-keyed lookup is `string | undefined`.
 */
type RowStatus = ProposalRow["status"];

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
  const runner = useActionRunner();

  /*
   * Filtered with a type guard rather than asserted. `row.proposed!.id`
   * appeared twice, and a non-null assertion on a field the view declares as
   * nullable is exactly the assertion that survives the schema change it
   * should have failed on.
   */
  const acceptable = review.rows.filter(isAcceptable);
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(acceptable.map((row) => row.proposed.id)),
  );
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");

  /** Accepting or rejecting sends the reader back to the week either way. */
  function decide<T>(action: () => Promise<ActionResult<T>>): void {
    void runner.run(action, {
      // The week screen is what gets re-read, and pushing to it does that.
      refresh: false,
      onSuccess: () => {
        router.push(weekHref);
        router.refresh();
      },
    });
  }

  function toggle(entryId: string): void {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(entryId)) next.delete(entryId);
      else next.add(entryId);
      return next;
    });
  }

  const statusLabel: Record<RowStatus, string> = {
    added: t("statusAdded"),
    changed: t("statusChanged"),
    removed: t("statusRemoved"),
    unchanged: t("statusUnchanged"),
  };

  /* The edge of each row says what would happen to that slot, before reading. */
  const statusClass: Record<RowStatus, string> = {
    added: "border-l-olive",
    changed: "border-l-amber-ink",
    removed: "border-l-danger",
    unchanged: "border-l-rule-strong opacity-80",
  };

  const statusChip: Record<RowStatus, string> = {
    added: "chip-ok",
    changed: "chip-warn",
    removed: "chip-danger",
    unchanged: "",
  };

  return (
    <div className="flex flex-col gap-6">
      <Feedback error={runner.feedback} warnings={runner.warnings} />

      {review.version.summary ? (
        <section className="rounded-[3px] border border-agent-line border-l-[3px] border-l-agent bg-agent-soft p-4">
          <h2 className="eyebrow pb-1.5 text-agent-ink">{t("summary")}</h2>
          <p className="lede text-ink">{review.version.summary}</p>
        </section>
      ) : null}

      <ul className="flex flex-col gap-3">
        {review.rows.map((row) => {
          const status = row.status;
          const entryId = row.proposed?.id ?? null;
          return (
            <li
              key={`${row.dayOfWeek}:${row.mealTypeId}`}
              className={`slip flex flex-col gap-3 border-l-[3px] p-4 ${statusClass[status]}`}
            >
              <div className="flex flex-wrap items-center gap-2.5">
                {entryId ? (
                  <input
                    type="checkbox"
                    checked={selected.has(entryId)}
                    onChange={() => toggle(entryId)}
                    aria-label={`${days(String(row.dayOfWeek))} ${row.mealTypeLabel}`}
                    className="h-5 w-5"
                  />
                ) : null}
                <span className="eyebrow text-ink">
                  {days(String(row.dayOfWeek))}{" "}
                  {row.mealTypeLabel.toLowerCase()}
                </span>
                <span className={`chip ${statusChip[status]}`}>
                  {statusLabel[status]}
                </span>
              </div>

              <div className="flex flex-col gap-1">
                <span className="display text-lg leading-snug">
                  {row.proposed
                    ? row.proposed.recipeTitleSnapshot
                    : t("proposedEmpty")}
                </span>
                <span className="micro">
                  {row.proposed
                    ? common("servings", { count: row.proposed.servings })
                    : ""}
                  {row.proposed ? " · " : ""}
                  {row.current
                    ? t("currentlyPlanned", {
                        title: row.current.recipeTitleSnapshot,
                      })
                    : t("currentlyEmpty")}
                </span>
                {row.proposed?.note ? (
                  <span className="text-sm italic text-muted">
                    {row.proposed.note}
                  </span>
                ) : null}
              </div>

              {row.proposed ? (
                <div className="flex flex-col gap-2 border-l-2 border-agent-line pl-3">
                  <span className="eyebrow text-agent-ink">
                    {t("rationale")}
                  </span>
                  <p className="prose text-base">
                    {row.proposed.rationale ?? t("noRationale")}
                  </p>
                  {row.citedFacts.length > 0 ? (
                    <>
                      <span className="micro">{t("citedFacts")}</span>
                      <ul className="flex flex-wrap gap-1.5">
                        {row.citedFacts.map((cited) => (
                          <li key={cited.id}>
                            <Link href="/faits" className="chip chip-agent">
                              {cited.statement}
                              {cited.status === "unconfirmed"
                                ? ` (${t("factUnconfirmed")})`
                                : ""}
                            </Link>
                          </li>
                        ))}
                      </ul>
                      <Link href="/faits" className="link self-start text-xs">
                        {t("editFacts")}
                      </Link>
                    </>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      {/* The decision bar stays reachable however long the diff runs. */}
      <div className="sticky bottom-4 z-10 flex flex-col gap-2 rounded-[3px] border border-rule-strong bg-surface p-4 shadow-[var(--shadow-slip)]">
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={runner.pending}
            onClick={() => decide(() => acceptProposalAction(week))}
            className="btn btn-primary"
          >
            {runner.pending ? t("working") : t("acceptAll")}
          </button>

          <button
            type="button"
            disabled={
              runner.pending ||
              selected.size === 0 ||
              selected.size === acceptable.length
            }
            onClick={() =>
              decide(() => acceptProposalEntriesAction(week, [...selected]))
            }
            className="btn btn-quiet"
          >
            {t("acceptSelected", { count: selected.size })}
          </button>

          <button
            type="button"
            onClick={() =>
              setSelected(
                selected.size === acceptable.length
                  ? new Set()
                  : new Set(acceptable.map((row) => row.proposed.id)),
              )
            }
            className="btn btn-ghost btn-sm"
          >
            {selected.size === acceptable.length
              ? t("selectNone")
              : t("selectAll")}
          </button>

          <button
            type="button"
            disabled={runner.pending}
            onClick={() => setRejecting(!rejecting)}
            className="btn btn-danger btn-sm ml-auto"
          >
            {t("reject")}
          </button>
        </div>
        <p className="hint">{t("acceptSelectedHelp")}</p>
      </div>

      {rejecting ? (
        <section className="flex flex-col gap-3 rounded-[3px] border border-danger-line border-l-[3px] border-l-danger bg-danger-soft p-4">
          <label className="label">
            <span>{t("rejectReason")}</span>
            <textarea
              rows={2}
              value={reason}
              placeholder={t("rejectReasonPlaceholder")}
              onChange={(event) => setReason(event.target.value)}
              className="field"
            />
            <span className="hint">{t("rejectReasonHelp")}</span>
          </label>
          <button
            type="button"
            disabled={runner.pending}
            onClick={() =>
              decide(() => rejectProposalAction(week, reason.trim() || null))
            }
            className="btn btn-danger self-start"
          >
            {t("rejectSubmit")}
          </button>
        </section>
      ) : null}
    </div>
  );
}
