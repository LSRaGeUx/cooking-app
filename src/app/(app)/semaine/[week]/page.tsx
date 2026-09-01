import Link from "next/link";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { VersionHistory } from "@/components/week/version-history";
import { WeekGrid } from "@/components/week/week-grid";
import {
  currentIsoWeek,
  formatIsoWeek,
  isoWeekDates,
  isSameIsoWeek,
  ISO_DAYS,
  parseIsoWeek,
  shiftIsoWeek,
} from "@/domain/week";
import { cycleContaining, formatCycleStart } from "@/domain/shopping";
import { requireUser } from "@/lib/session";
import { getProfile } from "@/services/profile-service";
import { pendingFeedback } from "@/services/feedback-service";
import { getWeekView, listVersions } from "@/services/plan-service";
import { loadPrepLinks } from "@/services/prep-service";
import { loadRecipeSummaries, searchRecipes } from "@/services/recipe-service";

/**
 * The week screen. Deep-linkable per ISO week, always with the year, because a
 * bare week number is ambiguous across the new year.
 *
 * Built from bands rather than from a document: a masthead cell holding the
 * week number, three figure cells beside it, a control band, then the wall.
 * Nothing is centred and nothing has a margin, so the grid runs to both edges
 * of the screen and the page reads as one continuous object.
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

  const locale = await getLocale();
  const dates = isoWeekDates(isoWeek);
  const dayFormatter = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
  const dayLabels = Object.fromEntries(
    ISO_DAYS.map((day) => [
      String(day),
      dayFormatter.format(dates[day - 1] ?? dates[0]!),
    ]),
  );
  const dayNumbers = Object.fromEntries(
    ISO_DAYS.map((day) => [
      String(day),
      String((dates[day - 1] ?? dates[0]!).getUTCDate()),
    ]),
  );
  const span = `${dayFormatter.format(dates[0]!)} – ${dayFormatter.format(dates[6]!)} ${isoWeek.year}`;

  const previous = shiftIsoWeek(isoWeek, -1);
  const next = shiftIsoWeek(isoWeek, 1);
  const today = currentIsoWeek();

  // The tomato day head only makes sense on the week that contains today.
  const now = new Date();
  const todayDayOfWeek = isSameIsoWeek(isoWeek, today)
    ? now.getDay() === 0
      ? 7
      : now.getDay()
    : null;

  // The shop that covers this week, and the column it lands on. Seeing the line
  // while planning is the point: everything after it is on the next shop.
  const profile = await getProfile(ctx);
  const shoppingCycle = cycleContaining(
    isSameIsoWeek(isoWeek, today) ? now : dates[0]!,
    profile.shoppingDay,
  );
  const groceryHref = `/courses/${formatCycleStart(shoppingCycle.startsOn)}`;

  const activeMinutes = view.entries.reduce(
    (total, entry) =>
      total +
      (entry.recipeId ? (activeTimeByRecipeId[entry.recipeId] ?? 0) : 0),
    0,
  );
  const figures = [
    { label: t("statMeals"), value: view.entries.length },
    { label: t("statMinutes"), value: activeMinutes },
    { label: t("statRecipes"), value: referencedIds.length },
  ];

  return (
    <div className="flex flex-col">
      <section className="wall grid-cols-3 border-t-0 lg:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))]">
        <div className="block col-span-3 flex flex-col gap-2 px-5 py-7 lg:col-span-1 lg:px-8">
          <span className="label-text text-muted">{t("label")}</span>
          <h1 className="mega wipe">
            <span className="sr-only">
              {t("title", { week: isoWeek.week, year: isoWeek.year })}
            </span>
            <span aria-hidden="true">
              {String(isoWeek.week).padStart(2, "0")}
            </span>
          </h1>
          <span className="micro">{span}</span>
        </div>

        {figures.map((figure) => (
          <div
            key={figure.label}
            className="block flex flex-col justify-between gap-4 px-4 py-5 lg:px-5"
          >
            <span className="numeral text-4xl lg:text-6xl">
              {String(figure.value).padStart(2, "0")}
            </span>
            <span className="label-text text-muted">{figure.label}</span>
          </div>
        ))}
      </section>

      <nav className="band flex flex-wrap items-center gap-3 bg-panel px-5 py-3 lg:px-8">
        <div className="segmented">
          <Link href={`/semaine/${formatIsoWeek(previous)}`}>
            <span aria-hidden="true">&lsaquo;&nbsp;</span>
            <span className="sr-only sm:not-sr-only">{t("previous")}</span>
          </Link>
          <Link href={`/semaine/${formatIsoWeek(today)}`}>{t("today")}</Link>
          <Link href={`/semaine/${formatIsoWeek(next)}`}>
            <span className="sr-only sm:not-sr-only">{t("next")}</span>
            <span aria-hidden="true">&nbsp;&rsaquo;</span>
          </Link>
        </div>
        <Link
          href={groceryHref}
          className="btn btn-primary ml-auto"
        >
          {t("groceryLink")}
        </Link>
      </nav>

      {awaiting.length > 0 ? (
        // A strip, never a modal: the spec is explicit that this prompt must
        // not block, and a prompt that blocks is a prompt people learn to
        // dismiss without reading.
        <aside className="band flex flex-wrap items-center gap-4 bg-yellow px-5 py-3 text-ink lg:px-8">
          <span className="lede">
            {t("feedbackPrompt", { count: awaiting.length })}
          </span>
          <Link
            href={`/semaine/${formatIsoWeek(isoWeek)}/bilan`}
            className="btn ml-auto"
          >
            {t("feedbackFill")}
          </Link>
        </aside>
      ) : null}

      {view.pendingVersion ? (
        // Cobalt, because this one is the agent speaking and nothing else on
        // the screen is.
        <aside className="band flex flex-wrap items-center gap-4 bg-cobalt px-5 py-3 text-on-cobalt lg:px-8">
          <span className="label-text">{t("createdByAgent")}</span>
          <span className="lede">{t("pendingBanner")}</span>
          <Link
            href={`/semaine/${formatIsoWeek(isoWeek)}/proposition`}
            className="btn ml-auto border-current bg-transparent text-current hover:bg-on-cobalt hover:text-cobalt"
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
        dayNumbers={dayNumbers}
        todayDayOfWeek={todayDayOfWeek}
        shoppingDayOfWeek={profile.shoppingDay}
      />

      <VersionHistory week={isoWeek} versions={versions} />
    </div>
  );
}
