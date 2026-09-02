import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { checkAccess } from "./access";
import { auth } from "./auth";
import { userContext, type ServiceContext } from "@/services/context";
import { ensureUserSetup } from "@/services/onboarding-service";

/**
 * The web entry point's half of tenancy. Every page and server action that
 * touches user data starts here, gets a ServiceContext, and passes it to the
 * service layer, which is the same layer the MCP endpoint calls.
 *
 * `cache` is React's per-request memo, so a page that needs the session in the
 * layout and again in three components pays for one round trip.
 */
export const getCurrentSession = cache(async () => {
  return auth.api.getSession({ headers: await headers() });
});

export interface CurrentUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
}

/**
 * Redirects to the login screen when there is no session, and when the session
 * belongs to an address that is no longer allowed here.
 *
 * The allowlist is re-read on every request rather than only at sign-in.
 * Better Auth's `validateUserInfo` gate runs on account creation, on linking
 * and on OAuth sign-in, so dropping an address blocks the next sign-in but
 * leaves a cookie already issued working until it expires. Checking here costs
 * nothing, since the session round trip has already happened, and it means
 * removal takes effect on the next page rather than at cookie expiry.
 *
 * First-run seeding happens here rather than on a sign-up hook: Better Auth
 * owns the user table and its lifecycle, and an idempotent ensure cannot be
 * skipped by a user that appeared some other way.
 */
export const requireUser = cache(async (): Promise<{
  user: CurrentUser;
  ctx: ServiceContext;
}> => {
  const session = await getCurrentSession();
  if (!session?.user) redirect("/login");

  const access = checkAccess(session.user.email);
  if (!access.allowed) redirect(`/login?error=${access.code}`);

  const ctx = userContext(session.user.id);
  await ensureUserSetup(ctx);

  return {
    user: {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
    },
    ctx,
  };
});
