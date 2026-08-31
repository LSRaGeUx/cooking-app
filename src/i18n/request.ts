import { getRequestConfig } from "next-intl/server";

/**
 * Single locale for now. The point of wiring next-intl from the first screen is
 * that no user-facing string is ever hardcoded, so adding English later is a
 * translation file rather than a refactor.
 */
export const locale = "fr" as const;

export default getRequestConfig(async () => ({
  locale,
  messages: (await import(`../../messages/${locale}.json`)).default,
}));
