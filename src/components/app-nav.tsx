"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { LocaleSwitch } from "@/components/locale-switch";
import { ThemeSwitch } from "@/components/theme-switch";
import { signOut } from "@/lib/sign-out";
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
 *
 * Both bars are flex children of .shell, not fixed overlays. That is what stops
 * them drifting away from the screen edges while iOS Safari animates its own
 * toolbars; globals.css carries the full reasoning. The consequence to remember
 * when editing this file is that a fragment has no DOM node of its own, so the
 * header and the bottom bar are direct children of the shell and are ordered by
 * flex, while the settings panel and the skip link are out of flow and are not
 * flex children at all.
 */

interface NavLink {
  readonly href: string;
  readonly label: string;
  readonly match: string;
}

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

  /*
   * A panel that survives a navigation is a panel in the way, and a `Link`
   * navigation does not pass through this component, so closing it cannot be
   * done in a click handler.
   *
   * What is stored is the path the panel was opened on, and "open" is that
   * path still being the current one. A navigation therefore closes it in the
   * same render that changes the path. It used to be a boolean reset by
   * `setIndexOpen(false)` inside an effect keyed on the pathname, which
   * React's hooks lint now reports and which paints the panel once more on the
   * new page before removing it.
   */
  const [openedAt, setOpenedAt] = useState<string | null>(null);
  const indexOpen = openedAt === pathname;

  const [signingOut, setSigningOut] = useState(false);

  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  /*
   * Focus goes into the panel when it opens and comes back to the block that
   * opened it when it closes. Neither happened before: the panel appeared with
   * focus still on the trigger and, once closed, focus was on an element that
   * no longer existed, which drops the reader back at the top of the document.
   *
   * A ref for the trigger rather than `document.activeElement`, because the
   * panel is also closed by a navigation and by Escape, and only the trigger is
   * always the right place to return to.
   */
  useEffect(() => {
    if (!indexOpen) return;
    const first = panelRef.current?.querySelector<HTMLElement>(
      'a, button, [tabindex]:not([tabindex="-1"])',
    );
    first?.focus();

    function onKey(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      setOpenedAt(null);
      triggerRef.current?.focus();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [indexOpen]);

  function closePanel(): void {
    setOpenedAt(null);
    triggerRef.current?.focus();
  }

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

  return (
    <>
      <a className="skip-link" href="#content">
        {t("skipToContent")}
      </a>

      {/* -------------------------------------------------------- top bar -- */}
      <header className="shell-bar shell-bar-top relative z-40 flex border-b-2 border-rule bg-panel">
        <Link
          href={weekHref}
          className="label-text flex shrink-0 items-center border-r-2 border-rule bg-tomato px-4 text-on-tomato"
        >
          {app("name")}
        </Link>

        {/*
          Named for what it holds. Both bars used to be labelled with the
          application's name, which gives a screen reader two landmarks called
          "Cooking App" and no way to tell them apart.
        */}
        <nav aria-label={t("groupPlan")} className="hidden lg:flex">
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
          ref={triggerRef}
          type="button"
          aria-expanded={indexOpen}
          onClick={() => (indexOpen ? closePanel() : setOpenedAt(pathname))}
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
            onClick={closePanel}
            className="fixed inset-0 z-30 cursor-default"
          />
          <div
            ref={panelRef}
            className="shell-panel fixed right-0 z-40 w-full max-w-xs border-b-2 border-l-2 border-rule bg-panel"
          >
            <nav aria-label={t("groupSettings")}>
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
            </nav>

            <div className="flex flex-wrap items-center gap-2 border-b-2 border-rule px-4 py-3">
              <LocaleSwitch />
              <ThemeSwitch current={theme} />
            </div>

            {/*
              One implementation, in src/lib/sign-out.ts, shared with the login
              screen. This used to be a second copy with no pending state and
              no error handling, so a failed request became an unhandled
              rejection and the user stayed signed in with nothing on screen to
              say so. It also clears the offline grocery cache, which otherwise
              survives a sign-out on a shared device.
            */}
            <button
              type="button"
              disabled={signingOut}
              onClick={() => {
                setSigningOut(true);
                void signOut()
                  .then(() => {
                    router.replace("/login");
                    router.refresh();
                  })
                  .catch((error: unknown) => {
                    console.error("Sign out did not complete", error);
                    setSigningOut(false);
                  });
              }}
              className="label-text fillable w-full px-4 py-3 text-left disabled:opacity-50"
            >
              {signingOut ? common("saving") : t("signOut")}
            </button>
          </div>
        </>
      ) : null}

      {/* --------------------------------------------------- phone bottom -- */}
      {/* order-last, because it is written above the content it sits below. */}
      <nav
        aria-label={app("name")}
        className="wall shell-bar shell-bar-bottom order-last grid-cols-4 border-l-0 border-t-2 bg-panel lg:hidden"
      >
        {primary.map((link) => (
          <Link
            key={link.match}
            href={link.href}
            aria-current={isActive(link) ? "page" : undefined}
            className={`label-text fillable flex items-center justify-center border-b-0 px-1 text-center ${
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
