"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { useTranslations } from "next-intl";
import { setThemeAction } from "@/app/actions/theme-actions";
import { themes, type Theme } from "@/lib/theme";

/**
 * Two buttons, like the locale switch, and for the same reason: with two values
 * a dropdown is one more tap and hides which one is on.
 */
export function ThemeSwitch({ current }: { current: Theme }) {
  const t = useTranslations("nav");
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const label: Record<Theme, string> = {
    light: t("themeLight"),
    dark: t("themeDark"),
  };

  return (
    <div className="segmented" role="group" aria-label={t("theme")}>
      {themes.map((theme) => (
        <button
          key={theme}
          type="button"
          disabled={pending || theme === current}
          aria-current={theme === current ? "true" : undefined}
          onClick={() =>
            startTransition(async () => {
              await setThemeAction(theme);
              router.refresh();
            })
          }
          className={theme === current ? "" : "cursor-pointer"}
        >
          {label[theme]}
        </button>
      ))}
    </div>
  );
}
