import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { CredentialsForm } from "@/components/auth/credentials-form";
import { getCurrentSession } from "@/lib/session";

/**
 * Target of the OAuth provider's `loginPage`. An MCP client that has never seen
 * this user lands here with the signed authorization query in the URL, so this
 * screen is both the ordinary login and the first step of connecting an agent.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const isOAuthRequest = typeof params.client_id === "string";

  // Someone already signed in who is not mid-authorization has no business
  // here. Mid-authorization, the provider drives the redirect itself.
  const session = await getCurrentSession();
  if (session?.user && !isOAuthRequest) redirect("/");

  const t = await getTranslations("login");

  return (
    <main className="mx-auto flex max-w-sm flex-col gap-6 px-6 py-16">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm opacity-70">{t("intro")}</p>
        {isOAuthRequest ? (
          <p className="rounded-md border border-black/10 px-3 py-2 text-sm opacity-80 dark:border-white/15">
            {t("oauthNotice")}
          </p>
        ) : null}
      </div>

      <CredentialsForm initialMode="login" />
    </main>
  );
}
