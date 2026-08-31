import { getTranslations } from "next-intl/server";

/**
 * Target of the OAuth provider's `consentPage`. The scopes the client asked for
 * arrive as query parameters. Phase 0 only needs the route to exist.
 */
export default async function ConsentPage() {
  const t = await getTranslations("consent");

  return (
    <main className="mx-auto flex max-w-sm flex-col gap-4 px-6 py-16">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <p className="text-sm opacity-70">{t("pending")}</p>
    </main>
  );
}
