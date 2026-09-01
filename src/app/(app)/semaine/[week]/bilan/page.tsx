import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { FeedbackBoard } from "@/components/week/feedback-board";
import { formatIsoWeek, parseIsoWeek } from "@/domain/week";
import { requireUser } from "@/lib/session";
import { loadFeedbackForEntries } from "@/services/feedback-service";
import { loadSignals } from "@/services/history-service";
import { getWeekView } from "@/services/plan-service";

/**
 * Filling in a whole past week in one screen, which is the only way this gets
 * done in practice: nobody answers seven separate prompts.
 */
export default async function WeekReviewPage({
  params,
}: {
  params: Promise<{ week: string }>;
}) {
  const { week: rawWeek } = await params;
  const isoWeek = parseIsoWeek(decodeURIComponent(rawWeek));
  if (!isoWeek) notFound();

  const { ctx } = await requireUser();
  const t = await getTranslations("feedback");

  const view = await getWeekView(ctx, isoWeek);
  const feedback = await loadFeedbackForEntries(
    ctx,
    view.entries.map((entry) => entry.id),
  );
  const { signals, budgetSuggestions } = await loadSignals(ctx);

  const rows = view.entries.map((entry) => {
    const slot = view.slots.find(
      (candidate) =>
        candidate.dayOfWeek === entry.dayOfWeek &&
        candidate.mealTypeId === entry.mealTypeId,
    );
    return {
      entryId: entry.id,
      dayOfWeek: entry.dayOfWeek,
      mealTypeLabel: slot?.mealTypeLabel ?? "",
      recipeTitle: entry.recipeTitleSnapshot,
      feedback: feedback.get(entry.id) ?? null,
    };
  });

  return (
    <div className="page mx-auto flex max-w-3xl flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-rule pb-4">
        <div className="flex flex-col gap-2">
          <h1 className="title rise">
            {t("title", { week: isoWeek.week, year: isoWeek.year })}
          </h1>
          <p className="lede">{t("intro")}</p>
        </div>
        <Link
          href={`/semaine/${formatIsoWeek(isoWeek)}`}
          className="btn btn-quiet btn-sm"
        >
          {t("backToWeek")}
        </Link>
      </header>

      <FeedbackBoard
        week={isoWeek}
        rows={rows}
        signals={signals}
        suggestions={budgetSuggestions}
      />
    </div>
  );
}
