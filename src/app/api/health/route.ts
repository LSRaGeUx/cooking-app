import { sql } from "drizzle-orm";
import { db } from "@/db/client";

/**
 * Liveness and readiness in one answer, for the container healthcheck, the
 * reverse proxy and any uptime monitor.
 *
 * It touches the database on purpose. A process that is listening but cannot
 * reach Postgres serves an error on every screen, and a check that only proves
 * Node accepted a socket would call that healthy. The query runs on the runtime
 * pool, so it also proves the least-privileged role is the one actually
 * configured rather than the owner.
 *
 * Nothing here is authenticated, which is why the body carries no version, no
 * configuration and no error text: an open endpoint on the public internet says
 * up or not up and nothing more. The reason goes to the server log.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const noStore = { "cache-control": "no-store" } as const;

export async function GET() {
  try {
    await db.execute(sql`select 1`);
    return Response.json({ status: "ok" }, { headers: noStore });
  } catch (error) {
    console.error("health: the database is unreachable", error);
    return Response.json(
      { status: "unavailable" },
      { status: 503, headers: noStore },
    );
  }
}
