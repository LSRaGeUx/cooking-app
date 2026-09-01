"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { LocaleSwitch } from "@/components/locale-switch";

export function AppNav({
  weekHref,
  groceryHref,
}: {
  weekHref: string;
  groceryHref: string;
}) {
  const t = useTranslations("nav");
  const app = useTranslations("app");
  const pathname = usePathname();
  const router = useRouter();

  const links = [
    { href: weekHref, label: t("week"), match: "/semaine" },
    { href: groceryHref, label: t("grocery"), match: "/courses" },
    { href: "/recettes", label: t("recipes"), match: "/recettes" },
    { href: "/placards", label: t("pantry"), match: "/placards" },
    { href: "/creneaux", label: t("slots"), match: "/creneaux" },
    { href: "/profil", label: t("profile"), match: "/profil" },
    { href: "/faits", label: t("facts"), match: "/faits" },
    { href: "/agent", label: t("agent"), match: "/agent" },
    { href: "/compte", label: t("account"), match: "/compte" },
  ];

  async function signOut() {
    await fetch("/api/auth/sign-out", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  return (
    <nav className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-black/10 px-4 py-3 dark:border-white/15">
      <span className="mr-2 text-sm font-semibold">{app("name")}</span>
      <ul className="flex flex-1 flex-wrap gap-1">
        {links.map((link) => {
          const active = pathname.startsWith(link.match);
          return (
            <li key={link.match}>
              <Link
                href={link.href}
                aria-current={active ? "page" : undefined}
                className={`rounded-md px-3 py-1.5 text-sm ${
                  active
                    ? "bg-black/10 font-medium dark:bg-white/15"
                    : "opacity-70 hover:opacity-100"
                }`}
              >
                {link.label}
              </Link>
            </li>
          );
        })}
      </ul>
      <LocaleSwitch />
      <button
        type="button"
        onClick={signOut}
        className="rounded-md px-3 py-1.5 text-sm opacity-70 hover:opacity-100"
      >
        {t("signOut")}
      </button>
    </nav>
  );
}
