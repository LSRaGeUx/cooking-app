import { cookies } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { defaultLocale, isLocale, LOCALE_COOKIE } from "./config";

/**
 * Two locales, chosen by a cookie rather than a URL segment.
 *
 * No `/fr/` or `/en/` prefix: the URLs in this application are bookmarked and
 * pasted (a week, a grocery list, the MCP endpoint page), and a locale segment
 * would make the same page two addresses. The cost is that the choice is
 * per-browser rather than shareable, which is the right trade for a
 * single-user, self-hosted product.
 *
 * English exists to prove the groundwork: every string goes through next-intl,
 * so a third locale is a translation file rather than a refactor, and
 * tests/messages.test.ts fails the build if the two catalogues drift apart.
 */
export default getRequestConfig(async () => {
  const store = await cookies();
  const requested = store.get(LOCALE_COOKIE)?.value;
  const locale = isLocale(requested) ? requested : defaultLocale;

  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
