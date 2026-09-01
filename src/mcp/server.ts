import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { registerResources } from "./resources";
import { registerGetProfileSnapshot } from "./tools/get-profile-snapshot";
import { registerGetRecipe } from "./tools/get-recipe";
import { registerGetWeek } from "./tools/get-week";
import { registerSearchRecipes } from "./tools/search-recipes";
import { registerWhoami } from "./tools/whoami";

export interface McpCallerContext {
  userId: string;
  clientId: string | undefined;
  scopes: ReadonlySet<string>;
}

/**
 * One server instance per request, stateless. Nothing is kept between calls, so
 * horizontal scaling needs no shared session store.
 */
export function buildServer(ctx: McpCallerContext): McpServer {
  const server = new McpServer({
    name: "cooking-app",
    version: "0.0.0",
  });

  registerWhoami(server, ctx);
  registerGetProfileSnapshot(server, ctx);
  registerSearchRecipes(server, ctx);
  registerGetRecipe(server, ctx);
  registerGetWeek(server, ctx);
  registerResources(server, ctx);

  return server;
}

export async function handleMcpRequest(
  request: Request,
  ctx: McpCallerContext,
): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  const server = buildServer(ctx);
  await server.connect(transport);
  return transport.handleRequest(request);
}
