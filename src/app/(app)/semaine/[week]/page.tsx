import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { VersionHistory } from "@/components/week/version-history";
import { WeekGrid } from "@/components/week/week-grid";
import {
  currentIsoWeek,
  formatIsoWeek,
  isoWeekDates,
  ISO_DAYS,
  parseIsoWeek,
  shiftIsoWeek,
} from "@/domain/week";
import { locale } from "@/i18n/request";
import { requireUser } from "@/lib/session";
import { pendingFeedback } from "@/services/feedback-service";
import { getWeekView, listVersions } from "@/services/plan-service";
import { loadPrepLinks } from "@/services/prep-service";
import { loadRecipeSummaries, searchRecipes } from "@/services/recipe-service";

/**
 * The week screen. Deep-linkable per ISO week, always with the year, because a
 * bare week number is ambiguous across the new year.
 */
export default async function WeekPage({
  params,
}: {
  params: Promise<{ week: string }>;
}) {
  const { week: rawWeek } = await params;
  const isoWeek = parseIsoWeek(decodeURIComponent(rawWeek));
  if (!isoWeek) notFound();

  const { ctx } = await requireUser();
  const t = await getTranslations("week");

  const view = await getWeekView(ctx, isoWeek);
  const versions = await listVersions(ctx, isoWeek);
  const awaiting = await pendingFeedback(ctx, isoWeek);
  const prepLinks = await loadPrepLinks(
    ctx,
    view.entries.map((entry) => entry.id),
  );
  const library = await searchRecipes(ctx, { limit: 30 });

  // Titles come from the entry snapshots, but the attended time has to come
  // from the recipe as it is now, because that is what the budget rule reads.
  const referencedIds = [
    ...new Set(
      [...view.entries, ...view.orphanedEntries]
        .map((entry) => entry.recipeId)
        .filter((id): id is string => id !== null),
    ),
  ];
  const summaries = await loadRecipeSummaries(ctx, referencedIds);
  const activeTimeByRecipeId = Object.fromEntries(
    [...summaries.values()].map((summary) => [summary.id, summary.activeTimeMin]),
  );

  const dates = isoWeekDates(isoWeek);
  const dateFormatter = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
  const dayLabels = Object.fromEntries(
    ISO_DAYS.map((day) => [
      String(day),
      dateFormatter.format(dates[day - 1] ?? dates[0]!),
    ]),
  );

  const previous = shiftIsoWeek(isoWeek, -1);
  const next = shiftIsoWeek(isoWeek, 1);
  const today = currentIsoWeek();

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-2xl font-semibold">
          {t("title", { week: isoWeek.week, year: isoWeek.year })}
        </h1>
        <nav className="flex items-center gap-3 text-sm">
          <Link href={`/semaine/${formatIsoWeek(previous)}`} className="underline">
            {t("previous")}
          </Link>
          <Link href={`/semaine/${formatIsoWeek(today)}`} className="underline">
            {t("today")}
          </Link>
          <Link href={`/semaine/${formatIsoWeek(next)}`} className="underline">
            {t("next")}
          </Link>
          <Link
            href={`/courses/${formatIsoWeek(isoWeek)}`}
            className="rounded-md border border-black/15 px-3 py-1.5 dark:border-white/20"
          >
            {t("groceryLink")}
          </Link>
        </nav>
      </header>

      {awaiting.length > 0 ? (
        // A strip, never a modal: the spec is explicit that this prompt must
        // not block, and a prompt that blocks is a prompt people learn to
        // dismiss without reading.
        <aside className="flex flex-wrap items-center gap-3 rounded-md border border-black/10 px-3 py-2 dark:border-white/15">
          <div className="flex flex-col">
            <span className="text-sm">
              {t("feedbackPrompt", { count: awaiting.length })}
            </span>
            <span className="text-xs opacity-60">{t("feedbackPromptHelp")}</span>
          </div>
          <Link
            href={`/semaine/${formatIsoWeek(isoWeek)}/bilan`}
            className="ml-auto rounded-md border border-black/15 px-3 py-1.5 text-sm dark:border-white/20"
          >
            {t("feedbackFill")}
          </Link>
        </aside>
      ) : null}

      {view.pendingVersion ? (
        <aside className="flex flex-wrap items-center gap-3 rounded-md border border-amber-500/50 bg-amber-500/5 px-3 py-2">
          <span className="text-sm">{t("pendingBanner")}</span>
          <Link
            href={`/semaine/${formatIsoWeek(isoWeek)}/proposition`}
            className="rounded-md bg-black px-3 py-1.5 text-sm font-medium text-white dark:bg-white dark:text-black"
          >
            {t("pendingReview")}
          </Link>
        </aside>
      ) : null}

      <WeekGrid
        week={isoWeek}
        slots={view.slots}
        entries={view.entries}
        orphanedEntries={view.orphanedEntries}
        recipes={library.recipes.map((recipe) => ({
          id: recipe.id,
          title: recipe.title,
          activeTimeMin: recipe.activeTimeMin,
          servings: recipe.servings,
        }))}
        prepLinks={prepLinks}
        activeTimeByRecipeId={activeTimeByRecipeId}
        dayLabels={dayLabels}
      />

      <VersionHistory week={isoWeek} versions={versions} />
    </div>
  );
}
