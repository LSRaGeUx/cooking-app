import { getTranslations } from "next-intl/server";

/**
 * The loading state for every screen behind the shell.
 *
 * There was none, so a navigation to a screen whose data is slow left the
 * previous page on screen with nothing happening. This is deliberately not a
 * skeleton of any particular screen: the four screens behind this boundary
 * look nothing like each other, and a skeleton that guesses wrong reads as a
 * broken page rather than as a loading one.
 *
 * A server component, so the string comes from the request's own catalogue
 * without shipping the loading state to the browser.
 */
export default async function Loading() {
  const common = await getTranslations("common");

  return (
    <div className="page flex items-center gap-3">
      <span
        aria-hidden="true"
        className="h-2 w-2 shrink-0 animate-pulse bg-tomato"
      />
      <p role="status" className="label-text text-muted">
        {common("loading")}
      </p>
    </div>
  );
}
