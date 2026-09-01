"use client";

import { useLocale } from "next-intl";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { setLocaleAction } from "@/app/actions/locale-actions";
import { locales } from "@/i18n/config";

/**
 * Two buttons rather than a select: with two locales a dropdown is one more tap
 * for no gain, and the current language stays readable at a glance.
 */
export function LocaleSwitch() {
  const current = useLocale();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex items-center gap-1" role="group" aria-label="Language">
      {locales.map((locale) => (
        <button
          key={locale}
          type="button"
          lang={locale}
          disabled={pending || locale === current}
          aria-current={locale === current ? "true" : undefined}
          onClick={() =>
            startTransition(async () => {
              await setLocaleAction(locale);
              router.refresh();
            })
          }
          className={`rounded px-1.5 py-0.5 text-xs uppercase ${
            locale === current ? "font-semibold" : "opacity-50 hover:opacity-100"
          }`}
        >
          {locale}
        </button>
      ))}
    </div>
  );
}
