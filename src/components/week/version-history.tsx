"use client";

import { useTranslations } from "next-intl";
import { revertToVersionAction } from "@/app/actions/plan-actions";
import { Feedback } from "@/components/feedback";
import type { PlanVersionState } from "@/domain/vocabulary";
import type { IsoWeek } from "@/domain/week";
import { useActionRunner } from "@/lib/use-action-runner";
import type { PlanVersionView } from "@/services/plan-service";

/**
 * The history is a product feature, not debugging output: it is the visible
 * proof that nothing the app or an agent does to a week is irreversible.
 * Reverting replays an old version into a new one, so the revert is itself
 * revertible and the list only ever grows.
 */
export function VersionHistory({
  week,
  versions,
}: {
  week: IsoWeek;
  versions: readonly PlanVersionView[];
}) {
  const t = useTranslations("week");
  const runner = useActionRunner();

  if (versions.length === 0) return null;

  const stateLabel: Record<PlanVersionState, string> = {
    active: t("stateActive"),
    superseded: t("stateSuperseded"),
    pending: t("statePending"),
    rejected: t("stateRejected"),
  };

  return (
    <section className="page flex flex-col gap-3">
      {/* A heading, not a div that looks like one: this section is reachable
          from the document outline and needs to say what it is. */}
      <h2 className="eyebrow eyebrow-rule">{t("versionHistory")}</h2>
      <p className="hint">{t("versionsHelp")}</p>
      <Feedback error={runner.feedback} warnings={runner.warnings} />
      <ol className="ruled flex flex-col">
        {versions.map((version) => (
          <li
            key={version.id}
            className="flex flex-wrap items-center gap-3 py-2.5"
          >
            <span className="micro w-10 text-ink">
              <span className="sr-only">
                {t("versionLabel", { number: version.versionNumber })}
              </span>
              <span aria-hidden="true">v{version.versionNumber}</span>
            </span>
            <span
              className={`chip ${version.state === "active" ? "chip-ok" : ""}`}
            >
              {labelFor(stateLabel, version.state)}
            </span>
            <span
              className={`chip ${
                version.createdBy === "agent" ? "chip-agent" : ""
              }`}
            >
              {version.createdBy === "agent"
                ? t("createdByAgent")
                : t("createdByUser")}
            </span>
            {version.state !== "active" ? (
              <button
                type="button"
                disabled={runner.pending}
                onClick={() =>
                  void runner.run(() =>
                    revertToVersionAction(week, version.versionNumber),
                  )
                }
                className="link ml-auto text-xs disabled:opacity-50"
              >
                {t("revert")}
              </button>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * `state` is typed `string` on the view, so a state the vocabulary does not
 * cover would index the record to undefined and render nothing. It falls back
 * to the raw value, which is at least legible.
 */
function labelFor(
  labels: Record<PlanVersionState, string>,
  state: string,
): string {
  return state in labels ? labels[state as PlanVersionState] : state;
}
