"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { revertToVersionAction } from "@/app/actions/plan-actions";
import { Feedback, type FeedbackState } from "@/components/feedback";
import type { IsoWeek } from "@/domain/week";
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
  const [feedback, setFeedback] = useState<FeedbackState>({});
  const [pending, setPending] = useState(false);
  const router = useRouter();

  if (versions.length === 0) return null;

  const stateLabel: Record<string, string> = {
    active: t("stateActive"),
    superseded: t("stateSuperseded"),
    pending: t("statePending"),
    rejected: t("stateRejected"),
  };

  async function revert(versionNumber: number): Promise<void> {
    setPending(true);
    const result = await revertToVersionAction(week, versionNumber);
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

  return (
    <section className="page flex flex-col gap-3">
      <div className="eyebrow eyebrow-rule">{t("versionHistory")}</div>
      <p className="hint">{t("versionsHelp")}</p>
      <Feedback {...feedback} />
      <ol className="ruled flex flex-col">
        {versions.map((version) => (
          <li key={version.id} className="flex flex-wrap items-center gap-3 py-2.5">
            <span className="micro w-10 text-ink">
              <span className="sr-only">
                {t("versionLabel", { number: version.versionNumber })}
              </span>
              <span aria-hidden="true">v{version.versionNumber}</span>
            </span>
            <span
              className={`chip ${version.state === "active" ? "chip-ok" : ""}`}
            >
              {stateLabel[version.state] ?? version.state}
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
                disabled={pending}
                onClick={() => void revert(version.versionNumber)}
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
