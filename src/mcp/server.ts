import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { registerPrompts } from "./prompts";
import { registerResources } from "./resources";
import { registerCheckFeasibility } from "./tools/check-feasibility";
import { registerFactWrites } from "./tools/fact-writes";
import { registerGetProfileSnapshot } from "./tools/get-profile-snapshot";
import { registerGetHistory } from "./tools/get-history";
import { registerGetRecipe } from "./tools/get-recipe";
import { registerGetWeek } from "./tools/get-week";
import { registerPantryTools } from "./tools/pantry";
import { registerProposeWeek } from "./tools/propose-week";
import { registerRecipeWrites } from "./tools/recipe-writes";
import { registerSearchRecipes } from "./tools/search-recipes";
import { registerUpdateSlot } from "./tools/update-slot";
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
  registerGetHistory(server, ctx);

  registerCheckFeasibility(server, ctx);
  registerProposeWeek(server, ctx);
  registerUpdateSlot(server, ctx);
  registerRecipeWrites(server, ctx);
  registerFactWrites(server, ctx);
  registerPantryTools(server, ctx);

  registerResources(server, ctx);
  registerPrompts(server, ctx);

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
