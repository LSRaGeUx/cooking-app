"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { LocaleSwitch } from "@/components/locale-switch";
import { ThemeSwitch } from "@/components/theme-switch";
import type { Theme } from "@/lib/theme";

/**
 * The shell, as a bar rather than a rail.
 *
 * The four places you actually go are welded into the top rule of every screen,
 * each a block that fills with ink when you point at it and stays filled where
 * you are. The nine settings screens sit behind one block, but as a panel
 * hanging off that block rather than as a takeover: blanking the screen to
 * change a setting loses the thing you were changing it for.
 *
 * On a phone the same four blocks move to the bottom, because the grocery list
 * is used one-handed in a shop.
 */

interface NavLink {
  readonly href: string;
  readonly label: string;
  readonly match: string;
}

const BAR = "h-13";

export function AppNav({
  weekHref,
  groceryHref,
  weekBadge,
  theme,
}: {
  weekHref: string;
  groceryHref: string;
  /** Printed in the bar: the week you are looking at, always. */
  weekBadge: string;
  /** Resolved on the server, so the switch never disagrees with the ground. */
  theme: Theme;
}) {
  const t = useTranslations("nav");
  const app = useTranslations("app");
  const common = useTranslations("common");
  const pathname = usePathname();
  const router = useRouter();
  const [indexOpen, setIndexOpen] = useState(false);

  // A panel that survives a navigation is a panel in the way.
  useEffect(() => {
    setIndexOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!indexOpen) return;
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") setIndexOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [indexOpen]);

  const primary: NavLink[] = [
    { href: weekHref, label: t("week"), match: "/semaine" },
    { href: groceryHref, label: t("grocery"), match: "/courses" },
    { href: "/recettes", label: t("recipes"), match: "/recettes" },
    { href: "/placards", label: t("pantry"), match: "/placards" },
  ];

  const settings: NavLink[] = [
    { href: "/creneaux", label: t("slots"), match: "/creneaux" },
    { href: "/profil", label: t("profile"), match: "/profil" },
    { href: "/faits", label: t("facts"), match: "/faits" },
    { href: "/agent", label: t("agent"), match: "/agent" },
    { href: "/compte", label: t("account"), match: "/compte" },
  ];

  const isActive = (link: NavLink): boolean => pathname.startsWith(link.match);
  const settingsActive = settings.some(isActive);

  async function signOut(): Promise<void> {
    // The body and its content type are not optional: the endpoint declares the
    // media types it accepts and answers 415 to a POST that names none, which
    // fails silently here because nothing reads the response.
    await fetch("/api/auth/sign-out", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    router.replace("/login");
    router.refresh();
  }

  return (
    <>
      <a className="skip-link" href="#content">
        {t("skipToContent")}
      </a>

      {/* -------------------------------------------------------- top bar -- */}
      <header
        className={`fixed inset-x-0 top-0 z-40 flex ${BAR} border-b-2 border-rule bg-panel`}
      >
        <Link
          href={weekHref}
          className="label-text flex shrink-0 items-center border-r-2 border-rule bg-tomato px-4 text-on-tomato"
        >
          {app("name")}
        </Link>

        <nav aria-label={app("name")} className="hidden lg:flex">
          {primary.map((link) => (
            <Link
              key={link.match}
              href={link.href}
              aria-current={isActive(link) ? "page" : undefined}
              className={`label-text fillable flex items-center border-r-2 border-rule px-5 ${
                isActive(link) ? "bg-ink text-on-ink" : ""
              }`}
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <span className="mono ml-auto hidden items-center border-l-2 border-rule px-4 text-muted sm:flex">
          {weekBadge}
        </span>

        <button
          type="button"
          aria-expanded={indexOpen}
          onClick={() => setIndexOpen((open) => !open)}
          className={`label-text fillable ml-auto flex items-center gap-2 border-l-2 border-rule px-5 sm:ml-0 ${
            indexOpen || settingsActive ? "bg-ink text-on-ink" : ""
          }`}
        >
          <span
            aria-hidden="true"
            className="flex flex-col gap-[3px] [&>i]:block [&>i]:h-[2px] [&>i]:w-3.5 [&>i]:bg-current"
          >
            <i />
            <i />
          </span>
          {indexOpen ? common("close") : t("groupSettings")}
        </button>
      </header>

      {/* --------------------------------------------------------- panel -- */}
      {indexOpen ? (
        <>
          <button
            type="button"
            aria-label={common("close")}
            onClick={() => setIndexOpen(false)}
            className="fixed inset-0 z-30 cursor-default"
          />
          <div className="fixed right-0 top-13 z-40 w-full max-w-xs border-b-2 border-l-2 border-rule bg-panel">
            <ul className="stack border-t-0">
              {settings.map((link, index) => (
                <li key={link.match}>
                  <Link
                    href={link.href}
                    aria-current={isActive(link) ? "page" : undefined}
                    className={`fillable flex items-baseline gap-3 px-4 py-3 ${
                      isActive(link) ? "bg-ink text-on-ink" : ""
                    }`}
                  >
                    <span className="mono opacity-50">
                      {String(index + 5).padStart(2, "0")}
                    </span>
                    <span className="label-text">{link.label}</span>
                  </Link>
                </li>
              ))}
            </ul>

            <div className="flex flex-wrap items-center gap-2 border-b-2 border-rule px-4 py-3">
              <LocaleSwitch />
              <ThemeSwitch current={theme} />
            </div>

            <button
              type="button"
              onClick={signOut}
              className="label-text fillable w-full px-4 py-3 text-left"
            >
              {t("signOut")}
            </button>
          </div>
        </>
      ) : null}

      {/* --------------------------------------------------- phone bottom -- */}
      <nav
        aria-label={app("name")}
        className="wall fixed inset-x-0 bottom-0 z-40 grid-cols-4 border-l-0 border-t-2 bg-panel lg:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {primary.map((link) => (
          <Link
            key={link.match}
            href={link.href}
            aria-current={isActive(link) ? "page" : undefined}
            className={`label-text fillable flex items-center justify-center border-b-0 px-1 py-3.5 text-center ${
              isActive(link) ? "bg-ink text-on-ink" : ""
            }`}
          >
            {link.label}
          </Link>
        ))}
      </nav>
    </>
  );
}
