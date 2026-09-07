import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { EmptyState } from "@/components/empty-state";

/**
 * What `notFound()` renders behind the shell.
 *
 * There was none, so a bad week number or a deleted recipe rendered Next's
 * default 404: in English, outside the shell, with no way back. This one keeps
 * the navigation, because the reader arrived here from a link they thought was
 * good and the next thing they want is a different link.
 */
export default async function NotFound() {
  const t = await getTranslations("errors");
  const common = await getTranslations("common");

  return (
    <div className="page">
      <EmptyState message={t("notFoundTitle")} help={t("notFoundHelp")}>
        <Link href="/" className="btn btn-primary">
          {common("back")}
        </Link>
      </EmptyState>
    </div>
  );
}
