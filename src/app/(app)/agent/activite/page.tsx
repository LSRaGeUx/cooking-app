import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { locale } from "@/i18n/request";
import { requireUser } from "@/lib/session";
import { listAgentActivity } from "@/services/activity-service";

/**
 * The full activity log. Append-only, and there is deliberately no way to edit
 * or delete an entry from anywhere in the app: a log an agent could tidy up
 * would not be worth reading.
 */
export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const page = Math.max(Number(params.page ?? "1") || 1, 1);
  const pageSize = 100;

  const { ctx } = await requireUser();
  const t = await getTranslations("agent");

  const { entries, total } = await listAgentActivity(ctx, {
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });

  const formatter = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "medium",
  });
  const lastPage = Math.max(Math.ceil(total / pageSize), 1);

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">{t("activity")}</h1>
          <p className="max-w-2xl text-sm opacity-70">{t("activityHelp")}</p>
          <p className="text-xs opacity-50">{t("total", { count: total })}</p>
        </div>
        <Link href="/agent" className="text-sm underline">
          {t("title")}
        </Link>
      </header>

      {entries.length === 0 ? (
        <p className="text-sm opacity-70">{t("activityEmpty")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-sm">
            <thead>
              <tr className="border-b border-black/10 text-left text-xs uppercase tracking-wide opacity-60 dark:border-white/15">
                <th className="py-2">{t("activityWhen")}</th>
                <th>{t("activityTool")}</th>
                <th>{t("activityResult")}</th>
                <th>{t("activityClient")}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr
                  key={entry.id}
                  className="border-b border-black/5 dark:border-white/10"
                >
                  <td className="py-2 text-xs opacity-70">
                    {formatter.format(entry.createdAt)}
                  </td>
                  <td>
                    <code className="text-xs">{entry.toolName}</code>
                    <span className="ml-2 text-xs opacity-50">
                      {entry.direction === "write"
                        ? t("directionWrite")
                        : t("directionRead")}
                    </span>
                  </td>
                  <td
                    className={`text-xs ${
                      entry.result === "ok"
                        ? "opacity-70"
                        : "text-amber-700 dark:text-amber-400"
                    }`}
                  >
                    {entry.result === "ok"
                      ? t("resultOk")
                      : entry.result === "rejected"
                        ? `${t("resultRejected")} · ${entry.rejectionCode ?? ""}`
                        : t("resultError")}
                  </td>
                  <td className="text-xs opacity-50">
                    {entry.oauthClientId ?? "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {lastPage > 1 ? (
        <nav className="flex gap-3 text-sm">
          {page > 1 ? (
            <Link href={`/agent/activite?page=${page - 1}`} className="underline">
              {page - 1}
            </Link>
          ) : null}
          <span className="opacity-60">{page}</span>
          {page < lastPage ? (
            <Link href={`/agent/activite?page=${page + 1}`} className="underline">
              {page + 1}
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
