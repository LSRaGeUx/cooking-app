import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { ConnectionPanel } from "@/components/agent/connection-panel";
import { requireUser } from "@/lib/session";
import { lastAgentCall, listAgentActivity } from "@/services/activity-service";
import { listConnectedClients } from "@/services/agent-client-service";

export default async function AgentPage() {
  const { ctx } = await requireUser();
  const t = await getTranslations("agent");

  const endpoint =
    process.env.MCP_RESOURCE ?? "http://localhost:3000/api/mcp";
  const clients = await listConnectedClients(ctx);
  const lastCall = await lastAgentCall(ctx);
  const recent = await listAgentActivity(ctx, { limit: 10 });

  const formatter = new Intl.DateTimeFormat(await getLocale(), {
    dateStyle: "medium",
    timeStyle: "short",
  });

  return (
    <div className="page flex flex-col gap-8">
      <header className="flex flex-col gap-2 border-b border-rule pb-4">
        <h1 className="title rise">{t("title")}</h1>
        <p className="lede">{t("intro")}</p>
      </header>

      <ConnectionPanel
        endpoint={endpoint}
        clients={clients}
        lastCallAt={lastCall ? formatter.format(lastCall) : null}
      />

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="eyebrow">{t("reviewFacts")}</h2>
          <Link href="/faits?status=unconfirmed" className="link text-sm">
            {t("reviewFacts")}
          </Link>
        </div>
        <p className="hint">{t("reviewFactsHelp")}</p>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="eyebrow">{t("activity")}</h2>
          <Link href="/agent/activite" className="link text-sm">
            {t("viewActivity")}
          </Link>
        </div>
        <p className="hint">{t("activityHelp")}</p>

        {recent.entries.length === 0 ? (
          <p className="hint">{t("activityEmpty")}</p>
        ) : (
          <ul className="ruled flex flex-col">
            {recent.entries.map((entry) => (
              <li
                key={entry.id}
                className="flex flex-wrap items-baseline gap-2.5 py-2"
              >
                {/* One dot, one glance: green ran, amber refused, red broke. */}
                <span
                  aria-hidden="true"
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    entry.result === "ok"
                      ? "bg-olive"
                      : entry.result === "rejected"
                        ? "bg-amber-ink"
                        : "bg-danger"
                  }`}
                />
                <code className="text-agent-ink">{entry.toolName}</code>
                <span className="micro">
                  {entry.direction === "write"
                    ? t("directionWrite")
                    : t("directionRead")}
                </span>
                <span
                  className={`micro ${
                    entry.result === "ok" ? "" : "text-amber-ink"
                  }`}
                >
                  {entry.result === "ok"
                    ? t("resultOk")
                    : entry.result === "rejected"
                      ? `${t("resultRejected")} · ${entry.rejectionCode ?? ""}`
                      : t("resultError")}
                </span>
                <span className="micro ml-auto">
                  {formatter.format(entry.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
