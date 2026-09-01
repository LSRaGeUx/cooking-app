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
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">{t("versionHistory")}</h2>
      <p className="text-xs opacity-70">{t("versionsHelp")}</p>
      <Feedback {...feedback} />
      <ol className="flex flex-col gap-1 text-sm">
        {versions.map((version) => (
          <li key={version.id} className="flex items-center gap-2">
            <span className="font-medium">
              {t("versionLabel", { number: version.versionNumber })}
            </span>
            <span className="text-xs opacity-60">
              {stateLabel[version.state] ?? version.state} ·{" "}
              {version.createdBy === "agent"
                ? t("createdByAgent")
                : t("createdByUser")}
            </span>
            {version.state !== "active" ? (
              <button
                type="button"
                disabled={pending}
                onClick={() => void revert(version.versionNumber)}
                className="text-xs underline disabled:opacity-50"
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
