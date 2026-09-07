import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { AuthShell } from "@/components/auth/auth-shell";
import { GoogleButton } from "@/components/auth/google-button";
import { SignOutLink } from "@/components/auth/sign-out-link";
import { NOT_ALLOWED, NOT_CONFIGURED, checkAccess } from "@/lib/access";
import { signInMethods } from "@/lib/auth";
import { getCurrentSession } from "@/lib/session";

/**
 * Target of the OAuth provider's `loginPage`. An MCP client that has never seen
 * this user lands here with the signed authorization query in the URL, so this
 * screen is both the ordinary login and the first step of connecting an agent.
 *
 * It is also where a refused sign-in lands, carrying `error`, because the
 * refusal that matters here is a person who is not on the allowlist and who
 * needs to read that rather than a stack of OAuth vocabulary.
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
  //
  // Unless their address was dropped from the allowlist: requireUser() sends
  // them back here, so bouncing them to `/` on the strength of the cookie alone
  // would be an endless round trip between the two screens.
  const session = await getCurrentSession();
  const stranded = session?.user
    ? !checkAccess(session.user.email).allowed
    : false;
  if (session?.user && !stranded && !isOAuthRequest) redirect("/");

  const t = await getTranslations("login");
  const refusal = refusalKey(params.error);

  return (
    <AuthShell>
      <div className="flex flex-col gap-3">
        <h1 className="title">{t("title")}</h1>
        <p className="lede">{t("intro")}</p>
        {isOAuthRequest ? (
          <p className="banner banner-agent">{t("oauthNotice")}</p>
        ) : null}
        {refusal ? (
          <p role="alert" className="banner banner-danger">
            {t(refusal)}
          </p>
        ) : null}
        {stranded ? <SignOutLink /> : null}
      </div>

      {/*
        Google is the only door a person uses. Password sign-in still exists on
        the HTTP API when AUTH_PASSWORD_LOGIN is set, because verify:oauth needs
        credentials to sign in with, but it is never offered here: a form on this
        screen is an invitation, and the flag is a development affordance.

        With no Google credentials configured there is genuinely nothing to
        click, and saying so beats a card with a heading and empty space under
        it. Start-up already refuses the case where no method at all is set.
      */}
      {signInMethods.google ? (
        <GoogleButton />
      ) : (
        <p role="alert" className="banner banner-danger">
          {t("noSignInMethod")}
        </p>
      )}
    </AuthShell>
  );
}

/**
 * Better Auth appends its own codes here too (`state_not_found`,
 * `invalid_code`, and friends), so anything unrecognised falls back to one
 * honest sentence rather than leaking a protocol term into the page.
 */
function refusalKey(
  error: string | string[] | undefined,
): "accessDenied" | "accessNotConfigured" | "signInFailed" | null {
  if (typeof error !== "string" || error.length === 0) return null;
  if (error === NOT_ALLOWED) return "accessDenied";
  if (error === NOT_CONFIGURED) return "accessNotConfigured";
  return "signInFailed";
}
