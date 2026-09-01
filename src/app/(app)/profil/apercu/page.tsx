import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { SnapshotView } from "@/components/profile/snapshot-view";
import { requireUser } from "@/lib/session";
import { composeProfileSnapshot } from "@/services/snapshot-service";

export default async function SnapshotPage() {
  const { ctx } = await requireUser();
  const t = await getTranslations("snapshot");

  // markReferenced stays false here on purpose: looking at your own snapshot
  // must not tell the pruning heuristic that an agent found these facts useful.
  const { snapshot, markdown } = await composeProfileSnapshot(ctx, {
    markReferenced: false,
  });

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">{t("title")}</h1>
          <p className="max-w-2xl text-sm opacity-70">{t("intro")}</p>
          <p className="text-xs opacity-50">
            {t("budget", {
              included: snapshot.factBudget.included,
              active: snapshot.factBudget.active,
            })}
          </p>
        </div>
        <Link href="/profil" className="text-sm underline">
          {t("backToProfile")}
        </Link>
      </header>

      <SnapshotView
        markdown={markdown}
        json={JSON.stringify(snapshot, null, 2)}
      />
    </div>
  );
}
