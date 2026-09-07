"use client";

import { NextIntlClientProvider, useTranslations } from "next-intl";
import { defaultLocale } from "@/i18n/config";
import messages from "../../messages/fr.json";
import "./globals.css";

/**
 * The last resort: the root layout itself failed to render.
 *
 * This boundary replaces the root layout while it is active, so it has to
 * declare its own `<html>` and `<body>`, and everything the layout provides is
 * gone with it. That includes `NextIntlClientProvider`, which is why the
 * catalogue is imported statically and a provider is set up here rather than
 * `useTranslations` being called against nothing.
 *
 * The locale is the default one rather than the reader's. Resolving the
 * reader's locale means reading a cookie on the server, and the cookie is read
 * by `src/i18n/request.ts` in the tree that just failed. An English reader
 * therefore sees this one screen in French. That is the honest trade for a
 * screen that only appears when the layout is broken, and it is better than
 * either Next's untranslated default or a sentence hardcoded outside the
 * catalogues. The copy lives in `messages/fr.json` like all the rest.
 *
 * `retry` rather than `reset`, per the Next 16 error-handling guide: `retry()`
 * re-fetches and re-renders, which is the only thing that can help here.
 */
export default function GlobalError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  return (
    // global-error must include html and body tags.
    <html lang={defaultLocale} data-theme="light">
      <body>
        <NextIntlClientProvider locale={defaultLocale} messages={messages}>
          <Fallback error={error} retry={retry} />
        </NextIntlClientProvider>
      </body>
    </html>
  );
}

function Fallback({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const t = useTranslations("errors");

  return (
    <main className="page flex flex-col items-start gap-5">
      <h1 className="title">{t("fatalTitle")}</h1>
      <p className="lede">{t("fatalHelp")}</p>
      {error.digest ? (
        <p className="micro">
          {t("digest")} <code className="mono">{error.digest}</code>
        </p>
      ) : null}
      <button type="button" onClick={() => retry()} className="btn btn-primary">
        {t("retry")}
      </button>
    </main>
  );
}
