import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";
import { ActivityResultDot } from "@/components/agent/activity-result";
import { ConnectionPanel } from "@/components/agent/connection-panel";
import { mcpResource } from "@/lib/config";
import { requireUser } from "@/lib/session";
import { lastAgentCall, listAgentActivity } from "@/services/activity-service";
import { listConnectedClients } from "@/services/agent-client-service";

export default async function AgentPage() {
  const { ctx } = await requireUser();
  const t = await getTranslations("agent");

  /*
   * Three independent reads and the locale, in parallel. They were awaited one
   * after another and none of them depends on another's result.
   */
  const [clients, lastCall, recent, locale] = await Promise.all([
    listConnectedClients(ctx),
    lastAgentCall(ctx),
    listAgentActivity(ctx, { limit: 10 }),
    getLocale(),
  ]);

  /*
   * Through `mcpResource()`, not `process.env.MCP_RESOURCE ?? "localhost"`.
   * A development fallback written at the point of use applies in production
   * too, which is how a deployed instance hands agents a dead address; ESLint
   * now refuses `process.env` outside src/lib/config.ts for that reason.
   */
  const endpoint = mcpResource();

  const formatter = new Intl.DateTimeFormat(locale, {
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
        /*
         * Dates formatted here, on the server, and handed over as strings. The
         * panel is a client component that is server-rendered, so formatting an
         * instant inside it produced one string on the server, in the server's
         * timezone, and another in the browser: a hydration mismatch and a
         * wrong time until React reconciled it.
         */
        clients={clients.map((client) => ({
          consentId: client.consentId,
          clientId: client.clientId,
          name: client.name,
          scopes: client.scopes,
          callsLast7Days: client.callsLast7Days,
          connectedAt: formatter.format(client.connectedAt),
          lastSeenAt:
            client.lastSeenAt === null
              ? null
              : formatter.format(client.lastSeenAt),
        }))}
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
                {/* One component, shared with the full log: the label and the
                    colour used to be written out on both screens. */}
                <ActivityResultDot
                  result={entry.result}
                  rejectionCode={entry.rejectionCode}
                />
                <code className="text-agent-ink">{entry.toolName}</code>
                <span className="micro">
                  {entry.direction === "write"
                    ? t("directionWrite")
                    : t("directionRead")}
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
