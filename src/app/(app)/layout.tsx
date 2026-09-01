import { AppNav } from "@/components/app-nav";
import { currentIsoWeek, formatIsoWeek } from "@/domain/week";
import { requireUser } from "@/lib/session";

/**
 * Everything behind this layout requires a session. Calling requireUser here as
 * well as in each page is deliberate: the layout is not a security boundary in
 * the App Router, so the guard belongs on the pages, and this call only shapes
 * the shell.
 */
export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  await requireUser();

  return (
    <div className="min-h-screen">
      <AppNav
        weekHref={`/semaine/${formatIsoWeek(currentIsoWeek())}`}
        groceryHref={`/courses/${formatIsoWeek(currentIsoWeek())}`}
      />
      <div className="mx-auto max-w-6xl px-4 py-6">{children}</div>
    </div>
  );
}
