import { getTranslations } from "next-intl/server";
import { DeleteAccount } from "@/components/account/delete-account";
import { requireUser } from "@/lib/session";

export default async function AccountPage() {
  const { user } = await requireUser();
  const t = await getTranslations("account");

  return (
    <div className="page mx-auto flex max-w-2xl flex-col gap-8">
      <header className="flex flex-col gap-2 border-b border-rule pb-4">
        <h1 className="title rise">{t("title")}</h1>
        <p className="lede">{t("intro")}</p>
        <p className="micro">{t("signedInAs", { email: user.email })}</p>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="eyebrow eyebrow-rule">{t("export")}</h2>
        <p className="hint">{t("exportHelp")}</p>
        <a
          href="/api/compte/export"
          download
          className="btn btn-quiet self-start"
        >
          {t("exportDownload")}
        </a>
      </section>

      <DeleteAccount />
    </div>
  );
}
