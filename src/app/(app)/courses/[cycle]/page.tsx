import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { GroceryList } from "@/components/grocery/grocery-list";
import {
  cycleContaining,
  cycleFromStart,
  formatCycleStart,
  isoWeeksInCycle,
  parseCycleStart,
  shiftCycle,
} from "@/domain/shopping";
import { formatIsoWeek, isoWeekStart, parseIsoWeek } from "@/domain/week";
import { loadProfile } from "@/lib/page-data";
import { requireUser } from "@/lib/session";
import { getGroceryList } from "@/services/grocery-service";
import { getWeekView } from "@/services/plan-service";

/**
 * Shopping screen, one shopping cycle per URL, identified by the date the cycle
 * starts on. Narrow by default because it is read in a shop, on a phone,
 * one-handed.
 *
 * A cycle is not a week and can straddle a Sunday, which is the whole point:
 * see docs/01-functional-spec.md section 8.1.
 */
export default async function GroceryPage({
  params,
}: {
  params: Promise<{ cycle: string }>;
}) {
  // Next hands over an already decoded param, so the `decodeURIComponent` that
  // used to be here was a second decode: a stray percent in the path threw a
  // URIError and produced a 500 where `parseCycleStart` gives a 404.
  const { cycle: raw } = await params;

  // Old links, and anything an agent may have handed back before cycles
  // existed, name an ISO week. Send them to the cycle starting that Monday
  // rather than 404, so a bookmark keeps working.
  const asWeek = parseIsoWeek(raw);
  if (asWeek) {
    redirect(`/courses/${formatCycleStart(isoWeekStart(asWeek))}`);
  }

  const startsOn = parseCycleStart(raw);
  if (!startsOn) notFound();
  const cycle = cycleFromStart(startsOn);

  const { ctx } = await requireUser();
  const t = await getTranslations("grocery");

  // A cycle can cover two weeks, so "is there anything planned" is a question
  // about all of them.
  const weeks = isoWeeksInCycle(cycle);
  const [firstWeek] = weeks;
  if (!firstWeek) notFound();

  /*
   * The list, the profile, the locale and every week the cycle covers, in
   * parallel. They were awaited one after another and none of them depends on
   * another's result.
   */
  const [list, profile, locale, views] = await Promise.all([
    getGroceryList(ctx, formatCycleStart(cycle.startsOn)),
    loadProfile(ctx),
    getLocale(),
    Promise.all(weeks.map((week) => getWeekView(ctx, week))),
  ]);

  const hasActivePlan = views.some(
    (view) => view.activeVersion !== null && view.entries.length > 0,
  );
  const weekHref = `/semaine/${formatIsoWeek(firstWeek)}`;

  const dayFormatter = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
  const range = t("cycleRange", {
    from: dayFormatter.format(cycle.startsOn),
    to: dayFormatter.format(cycle.endsOn),
  });

  const previous = shiftCycle(cycle, -1);
  const next = shiftCycle(cycle, 1);

  // Whether this is the shop you are in the middle of, which is the one thing
  // the range alone does not say.
  const current = cycleContaining(new Date(), profile.shoppingDay);
  const isCurrent = current.startsOn.getTime() === cycle.startsOn.getTime();

  return (
    <div className="flex flex-col">
      <section className="wall grid-cols-2 border-t-0 lg:grid-cols-[minmax(0,1fr)_auto]">
        <div className="block col-span-2 flex flex-col gap-2 px-5 py-6 lg:col-span-1 lg:px-8">
          <span className="label-text text-muted">
            {isCurrent ? `${t("currentCycle")} · ${range}` : range}
          </span>
          <h1 className="mega wipe">{t("title")}</h1>
          {list ? (
            <span className="micro">
              {t("generatedAt", {
                date: new Intl.DateTimeFormat(locale, {
                  dateStyle: "medium",
                  timeStyle: "short",
                }).format(list.updatedAt),
              })}
            </span>
          ) : null}
        </div>
        <Link
          href={weekHref}
          className="label-text fillable flex items-center justify-center px-6 py-5"
        >
          {t("goToWeek")}
        </Link>
      </section>

      {/* One cycle at a time, and a way to reach the shop before or after it. */}
      <nav className="band flex flex-wrap items-center gap-3 bg-panel px-5 py-3 lg:px-8">
        <div className="segmented">
          <Link href={`/courses/${formatCycleStart(previous.startsOn)}`}>
            <span aria-hidden="true">&lsaquo;&nbsp;</span>
            <span className="sr-only sm:not-sr-only">{t("previousCycle")}</span>
          </Link>
          <Link href={`/courses/${formatCycleStart(next.startsOn)}`}>
            <span className="sr-only sm:not-sr-only">{t("nextCycle")}</span>
            <span aria-hidden="true">&nbsp;&rsaquo;</span>
          </Link>
        </div>
      </nav>

      <GroceryList
        cycleStart={formatCycleStart(cycle.startsOn)}
        list={list}
        hasActivePlan={hasActivePlan}
        weekHref={weekHref}
        hasShoppingDay={profile.shoppingDay !== null}
      />
    </div>
  );
}
