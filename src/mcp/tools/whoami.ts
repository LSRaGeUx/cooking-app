import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpCallerContext } from "../server";
import { logAgentActivity } from "@/lib/activity-log";

/**
 * Phase 0 spike tool. Its only job is to prove the whole chain works end to end:
 * OAuth consent, an audience-bound access token, Streamable HTTP transport,
 * scope enforcement, a user-scoped database write under RLS, and the audit log.
 *
 * Tool and parameter descriptions are product copy: they are the only way to
 * steer an agent we do not run. See docs/03-agent-interface.md.
 */
export function registerWhoami(server: McpServer, ctx: McpCallerContext): void {
  server.registerTool(
    "whoami",
    {
      title: "Who am I",
      description:
        "Returns the Cooking App account this connection is authorized for, " +
        "and the scopes it was granted. Call this once after connecting to " +
        "confirm the connection works and to see what you are allowed to do.",
    },
    async () => {
      await logAgentActivity({
        userId: ctx.userId,
        oauthClientId: ctx.clientId,
        toolName: "whoami",
        direction: "read",
        result: "ok",
        payloadSummary: { scopes: [...ctx.scopes] },
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                userId: ctx.userId,
                clientId: ctx.clientId ?? null,
                scopes: [...ctx.scopes].sort(),
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
