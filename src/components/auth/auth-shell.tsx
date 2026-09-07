import { getTranslations } from "next-intl/server";
import { currentIsoWeek } from "@/domain/week";

/**
 * The frame around every signed-out screen.
 *
 * The left panel is not decoration for its own sake: it says what this thing is
 * before you have an account, and it prints the current week as an outline
 * numeral, which is the same mark the week screen uses once you are inside. The
 * form gets the narrow column, because on a phone the panel is gone entirely
 * and the form is the whole page.
 */
export async function AuthShell({ children }: { children: React.ReactNode }) {
  const app = await getTranslations("app");
  const week = currentIsoWeek();

  return (
    /*
     * 100dvh, not 100vh: on iOS the latter is the height the page would have
     * with the browser toolbars retracted, which gives a signed-out screen with
     * nothing on it a scrollbar the height of the toolbar.
     */
    <div className="grid min-h-[100dvh] lg:grid-cols-[1fr_30rem]">
      <aside className="relative hidden flex-col justify-between overflow-hidden border-r border-rule bg-sunk p-14 lg:flex">
        <div className="ledger pointer-events-none absolute inset-0 opacity-60" />

        <span className="eyebrow relative">{app("name")}</span>

        <p className="title relative max-w-[13ch]">{app("tagline")}</p>

        <span
          aria-hidden="true"
          className="numeral numeral-outline pointer-events-none absolute -bottom-14 -right-8 text-[20rem] leading-none"
        >
          {String(week.week).padStart(2, "0")}
        </span>
      </aside>

      {/* The page declares viewport-fit=cover, so the notch is the form's
          problem in landscape as much as the shell's. */}
      <main className="flex items-center justify-center px-6 py-16 [padding-left:calc(1.5rem+env(safe-area-inset-left))] [padding-right:calc(1.5rem+env(safe-area-inset-right))]">
        <div className="flex w-full max-w-sm flex-col gap-8">{children}</div>
      </main>
    </div>
  );
}
