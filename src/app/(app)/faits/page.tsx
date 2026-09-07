import { getTranslations } from "next-intl/server";
import { FactBoard } from "@/components/facts/fact-board";
import {
  FACT_CATEGORIES,
  FACT_STATUSES,
  DEFAULT_FACT_CAP,
} from "@/domain/vocabulary";
import { requireUser } from "@/lib/session";
import { countActiveFacts, listFacts } from "@/services/fact-service";

/**
 * The facts screen. Filters live in the URL so a filtered view is a link, and
 * so the back button behaves.
 */
export default async function FactsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const { ctx } = await requireUser();
  const t = await getTranslations("facts");

  const category = pickFrom(params.category, FACT_CATEGORIES);
  const status = pickFrom(params.status, FACT_STATUSES);
  const includeRetired = params.retired === "1";

  const facts = await listFacts(ctx, {
    ...(category ? { category } : {}),
    ...(status ? { status } : {}),
    includeRetired,
  });
  const activeCount = await countActiveFacts(ctx);

  return (
    <div className="page flex flex-col gap-6">
      <header className="flex flex-col gap-2 border-b border-rule pb-4">
        <h1 className="title rise">{t("title")}</h1>
        <p className="lede">{t("intro")}</p>
      </header>

      <FactBoard
        facts={facts}
        activeCount={activeCount}
        cap={DEFAULT_FACT_CAP}
        filter={{
          ...(category ? { category } : {}),
          ...(status ? { status } : {}),
          includeRetired,
        }}
      />
    </div>
  );
}

function pickFrom<T extends string>(
  value: string | string[] | undefined,
  allowed: readonly T[],
): T | undefined {
  if (typeof value !== "string") return undefined;
  return (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}
