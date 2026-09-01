import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { GroceryList } from "@/components/grocery/grocery-list";
import { formatIsoWeek, parseIsoWeek } from "@/domain/week";
import { locale } from "@/i18n/request";
import { requireUser } from "@/lib/session";
import { getGroceryList } from "@/services/grocery-service";
import { getWeekView } from "@/services/plan-service";

/**
 * Shopping screen, one week per URL like the plan it comes from. Narrow by
 * default because it is read in a shop, on a phone, one-handed.
 */
export default async function GroceryPage({
  params,
}: {
  params: Promise<{ week: string }>;
}) {
  const { week: rawWeek } = await params;
  const isoWeek = parseIsoWeek(decodeURIComponent(rawWeek));
  if (!isoWeek) notFound();

  const { ctx } = await requireUser();
  const t = await getTranslations("grocery");

  const list = await getGroceryList(ctx, isoWeek);
  const view = await getWeekView(ctx, isoWeek);
  const weekHref = `/semaine/${formatIsoWeek(isoWeek)}`;

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-col">
          <h1 className="text-2xl font-semibold">{t("title")}</h1>
          <p className="text-sm opacity-70">
            {t("subtitle", { week: isoWeek.week, year: isoWeek.year })}
          </p>
          {list ? (
            <p className="text-xs opacity-50">
              {t("generatedAt", {
                date: new Intl.DateTimeFormat(locale, {
                  dateStyle: "medium",
                  timeStyle: "short",
                }).format(list.updatedAt),
              })}
            </p>
          ) : null}
        </div>
        <Link href={weekHref} className="text-sm underline">
          {t("goToWeek")}
        </Link>
      </header>

      <GroceryList
        week={isoWeek}
        list={list}
        hasActivePlan={view.activeVersion !== null && view.entries.length > 0}
        weekHref={weekHref}
      />
    </div>
  );
}
