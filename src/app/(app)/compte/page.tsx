import { getTranslations } from "next-intl/server";
import { DeleteAccount } from "@/components/account/delete-account";
import { requireUser } from "@/lib/session";

export default async function AccountPage() {
  const { user } = await requireUser();
  const t = await getTranslations("account");

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm opacity-70">{t("intro")}</p>
        <p className="text-xs opacity-50">
          {t("signedInAs", { email: user.email })}
        </p>
      </header>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium uppercase tracking-wide opacity-60">
          {t("export")}
        </h2>
        <p className="max-w-2xl text-xs opacity-70">{t("exportHelp")}</p>
        <a
          href="/api/compte/export"
          download
          className="self-start rounded-md border border-black/15 px-3 py-2 text-sm dark:border-white/20"
        >
          {t("exportDownload")}
        </a>
      </section>

      <DeleteAccount />
    </div>
  );
}
