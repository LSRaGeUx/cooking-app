import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";
import { AppNav } from "@/components/app-nav";
import { currentIsoWeek, formatIsoWeek } from "@/domain/week";
import { requireUser } from "@/lib/session";
import { defaultTheme, isTheme, THEME_COOKIE } from "@/lib/theme";
import { cycleContaining, formatCycleStart } from "@/domain/shopping";
import { getProfile } from "@/services/profile-service";

/**
 * Everything behind this layout requires a session. Calling requireUser here as
 * well as in each page is deliberate: the layout is not a security boundary in
 * the App Router, so the guard belongs on the pages, and this call only shapes
 * the shell.
 *
 * No centred column and no page padding: screens are built from full-width
 * bands on the lattice, so each one decides its own margins. A container here
 * would put a gutter down both sides of every wall.
 */
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { ctx } = await requireUser();
  const t = await getTranslations("nav");

  const week = currentIsoWeek();

  // The bar points at the shop you are in the middle of, not at the calendar
  // week. On the shopping day itself that is already the cycle starting today.
  const profile = await getProfile(ctx);
  const cycle = cycleContaining(new Date(), profile.shoppingDay);
  const stored = (await cookies()).get(THEME_COOKIE)?.value;
  const theme = isTheme(stored) ? stored : defaultTheme;

  return (
    <div className="min-h-screen">
      <AppNav
        weekHref={`/semaine/${formatIsoWeek(week)}`}
        groceryHref={`/courses/${formatCycleStart(cycle.startsOn)}`}
        theme={theme}
        weekBadge={t("weekBadge", {
          // Strings, so the year is printed as 2026 and not grouped as 2 026.
          week: String(week.week).padStart(2, "0"),
          year: String(week.year),
        })}
      />
      {/* Clears the fixed bar, and the phone tab strip at the bottom. */}
      <main id="content" className="pb-16 pt-13 lg:pb-0">
        {children}
      </main>
    </div>
  );
}
