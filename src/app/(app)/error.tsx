"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";

/**
 * What a screen behind the shell shows when a read throws.
 *
 * There was no error boundary anywhere in the application, so a service that
 * threw rendered Next's own error screen: in English, unstyled, and with a
 * stack trace in development. Every string here comes from next-intl, which
 * works because this boundary is inside the root layout and therefore inside
 * `NextIntlClientProvider`. `global-error.tsx` is the one that is not, and it
 * says so.
 *
 * `retry` rather than `reset`. In Next 16 `retry()` re-fetches and re-renders
 * the boundary's children, which is what a failed database read needs;
 * `reset()` only clears the error state and re-renders what is already there,
 * so it would show the same failure again.
 */
export default function AppError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const t = useTranslations("errors");
  const common = useTranslations("common");

  useEffect(() => {
    // The digest is what correlates this screen with the server log line, and
    // it is the only part of a production error the browser is given.
    console.error("Screen failed to render", error);
  }, [error]);

  return (
    <div className="page flex flex-col items-start gap-5">
      <h1 className="title">{t("screenTitle")}</h1>
      <p className="lede">{t("screenHelp")}</p>
      {error.digest ? (
        <p className="micro">
          {t("digest")} <code className="mono">{error.digest}</code>
        </p>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => retry()}
          className="btn btn-primary"
        >
          {t("retry")}
        </button>
        <Link href="/" className="btn btn-quiet">
          {common("back")}
        </Link>
      </div>
    </div>
  );
}
