import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";
import { AuthShell } from "@/components/auth/auth-shell";
import { ConsentForm } from "@/components/auth/consent-form";
import { checkAccess } from "@/lib/access";
import { auth } from "@/lib/auth";
import { MCP_SCOPES, type McpScope } from "@/lib/scopes";
import { getCurrentSession } from "@/lib/session";

/**
 * Target of the OAuth provider's `consentPage`. The scopes the client asked for
 * arrive as query parameters, and the client is named from its registered
 * metadata: a consent screen that cannot say who is asking is not a consent
 * screen.
 *
 * Every scope is rendered in plain French. An authorization the user cannot
 * read is not an authorization they can give, and this is the screen the whole
 * agent story passes through.
 */
export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const t = await getTranslations("consent");

  const clientId =
    typeof params.client_id === "string" ? params.client_id : null;
  const requestedScopes = parseScopes(params.scope);

  /**
   * The provider only checks that a session exists before sending the browser
   * here, and a session outlives a removal from the allowlist. Refusing to draw
   * the form is the third place this is caught, after requireUser() and the MCP
   * tool runner: a token minted past this screen anyway opens nothing, because
   * every tool call re-checks, but a consent screen that offers to grant an
   * access the instance has withdrawn is a lie to the person reading it.
   */
  const session = await getCurrentSession();
  const allowed = session?.user
    ? checkAccess(session.user.email).allowed
    : false;
  if (!allowed) {
    return (
      <AuthShell>
        <h1 className="title">{t("title")}</h1>
        <p role="alert" className="banner banner-danger">
          {t("notAllowed")}
        </p>
      </AuthShell>
    );
  }

  const clientName = clientId ? await clientNameOf(clientId) : null;

  if (!clientId) {
    return (
      <AuthShell>
        <h1 className="title">{t("title")}</h1>
        <p className="lede">{t("missingRequest")}</p>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <div className="flex flex-col gap-3">
        <h1 className="title">{t("title")}</h1>
        <p className="lede text-ink">
          {clientName
            ? t("intro", { client: clientName })
            : t("introUnknownClient")}
        </p>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="eyebrow eyebrow-rule">{t("scopes")}</h2>
        <ul className="ruled flex flex-col rounded-[3px] border border-agent-line border-l-[3px] border-l-agent bg-agent-soft px-4 text-sm">
          {requestedScopes.map((scope) => (
            <li key={scope} className="py-2.5">
              {scopeLabel(t, scope)}
            </li>
          ))}
        </ul>
      </section>

      <ConsentForm />
    </AuthShell>
  );
}

function parseScopes(value: string | string[] | undefined): string[] {
  const raw = Array.isArray(value) ? value.join(" ") : (value ?? "");
  const scopes = raw.split(/[\s+]+/).filter((scope) => scope.length > 0);
  return scopes.length > 0 ? scopes : ["openid"];
}

/**
 * An unknown scope is shown verbatim rather than hidden: a permission we cannot
 * describe is exactly the one the user most needs to see.
 */
function scopeLabel(
  t: Awaited<ReturnType<typeof getTranslations<"consent">>>,
  scope: string,
): string {
  return isKnownScope(scope) ? t(`scopeNames.${scope}`) : scope;
}

function isKnownScope(scope: string): scope is McpScope {
  return (MCP_SCOPES as readonly string[]).includes(scope);
}

async function clientNameOf(clientId: string): Promise<string | null> {
  try {
    // The endpoint is session-guarded, so the incoming cookies have to be
    // forwarded: without them it answers 401 and the screen silently loses the
    // one fact that makes consent meaningful, which is who is asking.
    const client = await auth.api.getOAuthClientPublic({
      query: { client_id: clientId },
      headers: await headers(),
    });
    // The endpoint answers in OAuth's snake_case, so the field is client_name.
    const name = (client as { client_name?: unknown } | null)?.client_name;
    return typeof name === "string" && name.length > 0 ? name : null;
  } catch {
    // A client that cannot be read is still a client that can be authorized;
    // the screen falls back to the anonymous wording rather than failing.
    return null;
  }
}
