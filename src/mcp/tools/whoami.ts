import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpCallerContext } from "../server";
import { toolJson } from "../serializers";
import { runTool } from "../tool-runner";

/**
 * The connection test. It began as the phase 0 spike tool, proving the whole
 * chain worked end to end: OAuth consent, an audience-bound token, Streamable
 * HTTP, a user-scoped write under RLS, and the audit log.
 *
 * It now runs through the same guard as every other tool. That matters more
 * than it looks: this is the call an agent makes to check its connection, so it
 * is exactly the call that must notice a revoked client rather than cheerfully
 * reporting that everything is fine.
 */
export function registerWhoami(
  server: McpServer,
  caller: McpCallerContext,
): void {
  server.registerTool(
    "whoami",
    {
      title: "Vérifier la connexion",
      description:
        "Renvoie le compte auquel cette connexion est rattachée et les " +
        "autorisations accordées. Appelez-le une fois après la connexion pour " +
        "confirmer que tout fonctionne et voir ce que vous avez le droit de faire.",
    },
    async () =>
      runTool(
        caller,
        {
          name: "whoami",
          direction: "read",
          // The floor the endpoint already enforces. Named here anyway so the
          // tool states its own requirement rather than inheriting it silently.
          requiredScopes: ["profile:read"],
          payloadSummary: { scopes: caller.scopes.size },
        },
        async () =>
          toolJson({
            user_id: caller.userId,
            client_id: caller.clientId,
            scopes: [...caller.scopes].sort(),
          }),
      ),
  );
}
