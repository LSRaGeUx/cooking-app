"use client";

import { useLocale, useTranslations } from "next-intl";
import { useTransition } from "react";
import { setLocaleAction } from "@/app/actions/locale-actions";
import { locales } from "@/i18n/config";

/**
 * Two buttons rather than a select: with two locales a dropdown is one more tap
 * for no gain, and the current language stays readable at a glance.
 */
export function LocaleSwitch() {
  const current = useLocale();
  const t = useTranslations("nav");
  const [pending, startTransition] = useTransition();

  return (
    // Was `aria-label="Language"`, hardcoded in English, on the one control in
    // the application whose entire job is not to be in one language.
    <div className="segmented" role="group" aria-label={t("language")}>
      {locales.map((locale) => (
        <button
          key={locale}
          type="button"
          lang={locale}
          disabled={pending || locale === current}
          aria-current={locale === current ? "true" : undefined}
          onClick={() =>
            // No `router.refresh()`: the action already calls
            // `revalidatePath("/", "layout")`, which purges the client cache
            // and re-renders the tree. Refreshing as well fetched the same
            // page twice on every switch.
            startTransition(() => setLocaleAction(locale))
          }
          className={locale === current ? "" : "cursor-pointer"}
        >
          {locale}
        </button>
      ))}
    </div>
  );
}
