import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { ConnectionPanel } from "@/components/agent/connection-panel";
import { locale } from "@/i18n/request";
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

  const formatter = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="max-w-2xl text-sm opacity-70">{t("intro")}</p>
      </header>

      <ConnectionPanel
        endpoint={endpoint}
        clients={clients}
        lastCallAt={lastCall ? formatter.format(lastCall) : null}
      />

      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-medium uppercase tracking-wide opacity-60">
            {t("activity")}
          </h2>
          <Link href="/agent/activite" className="text-sm underline">
            {t("viewActivity")}
          </Link>
        </div>
        <p className="max-w-2xl text-xs opacity-70">{t("activityHelp")}</p>

        {recent.entries.length === 0 ? (
          <p className="text-sm opacity-70">{t("activityEmpty")}</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {recent.entries.map((entry) => (
              <li
                key={entry.id}
                className="flex flex-wrap items-baseline gap-2 border-b border-black/5 py-1 dark:border-white/10"
              >
                <code className="text-xs">{entry.toolName}</code>
                <span className="text-xs opacity-60">
                  {entry.direction === "write"
                    ? t("directionWrite")
                    : t("directionRead")}
                </span>
                <span
                  className={`text-xs ${
                    entry.result === "ok"
                      ? "opacity-60"
                      : "text-amber-700 dark:text-amber-400"
                  }`}
                >
                  {entry.result === "ok"
                    ? t("resultOk")
                    : entry.result === "rejected"
                      ? `${t("resultRejected")} · ${entry.rejectionCode ?? ""}`
                      : t("resultError")}
                </span>
                <span className="ml-auto text-xs opacity-50">
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
