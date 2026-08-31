import { getTranslations } from "next-intl/server";

/**
 * Target of the OAuth provider's `loginPage`. Phase 0 only needs the route to
 * exist so the authorization code flow can redirect here. The real form lands
 * with the rest of the auth UI.
 */
export default async function LoginPage() {
  const t = await getTranslations("login");

  return (
    <main className="mx-auto flex max-w-sm flex-col gap-4 px-6 py-16">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>
      <p className="text-sm opacity-70">{t("pending")}</p>
    </main>
  );
}
