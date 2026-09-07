import { requireUser } from "@/lib/session";
import { exportAccount } from "@/services/account-service";

/**
 * The whole account as one JSON file.
 *
 * A route handler rather than a server action, because this is a download: the
 * browser needs a response with a filename, not a value returned into a
 * component.
 */
export async function GET(): Promise<Response> {
  const { ctx } = await requireUser();
  const data = await exportAccount(ctx);
  const stamp = new Date().toISOString().slice(0, 10);

  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="cooking-app-${stamp}.json"`,
      // Never cached: it is a snapshot of everything the account holds.
      "cache-control": "no-store",
      // The body is whatever the user typed, served from our own origin. Without
      // this a browser is free to sniff it as HTML and run any script inside a
      // recipe title or a fact, on this origin, with this session.
      "x-content-type-options": "nosniff",
    },
  });
}
