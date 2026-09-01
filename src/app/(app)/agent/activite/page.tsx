import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
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

  const formatter = new Intl.DateTimeFormat(await getLocale(), {
    dateStyle: "medium",
    timeStyle: "medium",
  });
  const lastPage = Math.max(Math.ceil(total / pageSize), 1);

  return (
    <div className="page flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-rule pb-4">
        <div className="flex flex-col gap-2">
          <h1 className="title rise">{t("activity")}</h1>
          <p className="lede">{t("activityHelp")}</p>
          <p className="micro">{t("total", { count: total })}</p>
        </div>
        <Link href="/agent" className="btn btn-quiet btn-sm">
          {t("title")}
        </Link>
      </header>

      {entries.length === 0 ? (
        <p className="hint">{t("activityEmpty")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] text-sm">
            <thead>
              <tr className="border-b border-rule-strong text-left">
                <th className="eyebrow py-2">{t("activityWhen")}</th>
                <th className="eyebrow">{t("activityTool")}</th>
                <th className="eyebrow">{t("activityResult")}</th>
                <th className="eyebrow">{t("activityClient")}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id} className="border-b border-rule">
                  <td className="micro py-2.5">
                    {formatter.format(entry.createdAt)}
                  </td>
                  <td>
                    <code className="text-agent-ink">{entry.toolName}</code>
                    <span className="micro ml-2">
                      {entry.direction === "write"
                        ? t("directionWrite")
                        : t("directionRead")}
                    </span>
                  </td>
                  <td>
                    <span
                      className={`chip ${
                        entry.result === "ok"
                          ? "chip-ok"
                          : entry.result === "rejected"
                            ? "chip-warn"
                            : "chip-danger"
                      }`}
                    >
                      {entry.result === "ok"
                        ? t("resultOk")
                        : entry.result === "rejected"
                          ? `${t("resultRejected")} · ${entry.rejectionCode ?? ""}`
                          : t("resultError")}
                    </span>
                  </td>
                  <td className="micro">{entry.oauthClientId ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {lastPage > 1 ? (
        <nav className="segmented self-start">
          {page > 1 ? (
            <Link href={`/agent/activite?page=${page - 1}`}>{page - 1}</Link>
          ) : null}
          <span aria-current="true">{page}</span>
          {page < lastPage ? (
            <Link href={`/agent/activite?page=${page + 1}`}>{page + 1}</Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
