import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { ActivityResultChip } from "@/components/agent/activity-result";
import { activityQuerySchema } from "@/domain/schemas";
import { requireUser } from "@/lib/session";
import { listAgentActivity } from "@/services/activity-service";

/**
 * The full activity log. Append-only, and there is deliberately no way to edit
 * or delete an entry from anywhere in the app: a log an agent could tidy up
 * would not be worth reading.
 */
const PAGE_SIZE = 100;

export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;

  /*
   * A positive integer, through the domain schema. `Number(params.page)`
   * accepted "1.5" and produced a fractional offset, and "1e3" a page nobody
   * asked for. The parse falls back to the first page rather than refusing,
   * because a bad query string in a log viewer is a typo, not an error worth a
   * screen of its own.
   */
  const page = pageNumber(params.page);
  const query = activityQuerySchema.parse({
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });

  const { ctx } = await requireUser();
  const t = await getTranslations("agent");

  const [{ entries, total }, locale] = await Promise.all([
    listAgentActivity(ctx, query),
    getLocale(),
  ]);

  const formatter = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "medium",
  });
  const lastPage = Math.max(Math.ceil(total / PAGE_SIZE), 1);

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
                    {/* One component, shared with the agent screen. */}
                    <ActivityResultChip
                      result={entry.result}
                      rejectionCode={entry.rejectionCode}
                    />
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

function pageNumber(value: string | string[] | undefined): number {
  if (typeof value !== "string") return 1;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return 1;
  // The schema caps the offset it will accept, and a page far past the end
  // returns nothing anyway, so the number is bounded here rather than refused.
  return Math.min(parsed, 100_000);
}
