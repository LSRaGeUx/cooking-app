import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { ProposalReviewPanel } from "@/components/week/proposal-review";
import { formatIsoWeek, parseIsoWeek } from "@/domain/week";
import { requireUser } from "@/lib/session";
import { getProposalReview } from "@/services/plan-service";

/**
 * The target of the `review_url` an agent hands back in chat. This is the
 * handoff from the conversation to the app, and the moment the product either
 * feels seamless or does not.
 */
export default async function ProposalPage({
  params,
}: {
  params: Promise<{ week: string }>;
}) {
  const { week: rawWeek } = await params;
  const isoWeek = parseIsoWeek(decodeURIComponent(rawWeek));
  if (!isoWeek) notFound();

  const { ctx } = await requireUser();
  const t = await getTranslations("proposal");

  const review = await getProposalReview(ctx, isoWeek);
  const weekHref = `/semaine/${formatIsoWeek(isoWeek)}`;

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">
            {t("title", { week: isoWeek.week, year: isoWeek.year })}
          </h1>
          <p className="max-w-2xl text-sm opacity-70">{t("intro")}</p>
          {review ? (
            <p className="text-xs opacity-50">
              {t("writtenBy", { number: review.version.versionNumber })}
            </p>
          ) : null}
        </div>
        <Link href={weekHref} className="text-sm underline">
          {t("backToWeek")}
        </Link>
      </header>

      {review === null ? (
        <p className="text-sm opacity-70">{t("none")}</p>
      ) : (
        <ProposalReviewPanel
          week={isoWeek}
          review={review}
          weekHref={weekHref}
        />
      )}
    </div>
  );
}
