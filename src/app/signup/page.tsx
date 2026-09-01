import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { CredentialsForm } from "@/components/auth/credentials-form";
import { getCurrentSession } from "@/lib/session";

export default async function SignUpPage() {
  const session = await getCurrentSession();
  if (session?.user) redirect("/");

  const t = await getTranslations("signup");

  return (
    <main className="mx-auto flex max-w-sm flex-col gap-6 px-6 py-16">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm opacity-70">{t("intro")}</p>
      </div>

      <CredentialsForm initialMode="signup" />
    </main>
  );
}
