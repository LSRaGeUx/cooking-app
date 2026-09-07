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
  // No `decodeURIComponent`: Next hands params over already decoded, so the
  // second decode threw a URIError on a stray percent and turned what should
  // be a 404 into a 500.
  const { week: rawWeek } = await params;
  const isoWeek = parseIsoWeek(rawWeek);
  if (!isoWeek) notFound();

  const { ctx } = await requireUser();
  const t = await getTranslations("proposal");

  const review = await getProposalReview(ctx, isoWeek);
  const weekHref = `/semaine/${formatIsoWeek(isoWeek)}`;

  return (
    <div className="page mx-auto flex max-w-3xl flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-rule pb-4">
        <div className="flex flex-col gap-2">
          {review ? (
            <span className="chip chip-agent self-start">
              {t("writtenBy", { number: review.version.versionNumber })}
            </span>
          ) : null}
          <h1 className="title rise">
            {t("title", { week: isoWeek.week, year: isoWeek.year })}
          </h1>
          <p className="lede">{t("intro")}</p>
        </div>
        <Link href={weekHref} className="btn btn-quiet btn-sm">
          {t("backToWeek")}
        </Link>
      </header>

      {review === null ? (
        <p className="hint">{t("none")}</p>
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
