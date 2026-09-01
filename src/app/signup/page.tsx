import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { AuthShell } from "@/components/auth/auth-shell";
import { CredentialsForm } from "@/components/auth/credentials-form";
import { signInMethods } from "@/lib/auth";
import { getCurrentSession } from "@/lib/session";

/**
 * Self-service sign-up only exists while the development password door is open.
 * With Google alone there is nothing to fill in: the account is created on first
 * sign-in if the address is on the allowlist, so this screen would be a form
 * that asks for what Google already answered.
 */
export default async function SignUpPage() {
  if (!signInMethods.passwordLogin) redirect("/login");

  const session = await getCurrentSession();
  if (session?.user) redirect("/");

  const t = await getTranslations("signup");

  return (
    <AuthShell>
      <div className="flex flex-col gap-3">
        <h1 className="title">{t("title")}</h1>
        <p className="lede">{t("intro")}</p>
      </div>

      <CredentialsForm initialMode="signup" />
    </AuthShell>
  );
}
