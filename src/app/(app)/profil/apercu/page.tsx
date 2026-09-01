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
    <div className="page flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-rule pb-4">
        <div className="flex flex-col gap-2">
          <h1 className="title rise">{t("title")}</h1>
          <p className="lede">{t("intro")}</p>
          <p className="micro">
            {t("budget", {
              included: snapshot.factBudget.included,
              active: snapshot.factBudget.active,
            })}
          </p>
        </div>
        <Link href="/profil" className="btn btn-quiet btn-sm">
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
