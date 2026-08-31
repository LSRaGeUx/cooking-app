import { getTranslations } from "next-intl/server";

export default async function Home() {
  const t = await getTranslations();

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-16">
      <h1 className="text-3xl font-semibold">{t("app.name")}</h1>
      <p className="text-lg opacity-80">{t("app.tagline")}</p>
      <p className="text-sm uppercase tracking-wide opacity-60">
        {t("home.status")}
      </p>
      <dl className="rounded-lg border border-black/10 p-4 text-sm dark:border-white/15">
        <dt className="font-medium">{t("home.mcpReady")}</dt>
        <dd className="font-mono opacity-70">/api/mcp</dd>
      </dl>
      <p className="text-sm opacity-70">{t("home.docs")}</p>
    </main>
  );
}
