import { requireMcpAuth } from "@better-auth/mcp";
import type { JWTPayload } from "jose";
import { auth } from "@/lib/auth";
import { handleMcpRequest, type McpCallerContext } from "@/mcp/server";

/** OAuth scope claims are a single space-delimited string (RFC 8693). */
function parseScopes(claims: JWTPayload): ReadonlySet<string> {
  const raw = claims["scope"];
  if (typeof raw !== "string") return new Set();
  return new Set(raw.split(" ").filter(Boolean));
}

function callerFrom(claims: JWTPayload): McpCallerContext {
  const userId = claims.sub;
  if (!userId) {
    throw new Error("Access token carries no subject");
  }
  const clientId = claims["client_id"] ?? claims["azp"];
  return {
    userId,
    clientId: typeof clientId === "string" ? clientId : undefined,
    scopes: parseScopes(claims),
  };
}

/**
 * requireMcpAuth verifies the bearer token against our own JWKS, checking
 * signature, issuer, audience, and expiry, and answers unauthenticated requests
 * with a JSON-RPC 401 carrying the RFC 9728 WWW-Authenticate header. That header
 * is what lets an MCP client discover where to authorize, which is the entire
 * one-URL connection story.
 *
 * Bearer only, never the session cookie: otherwise a malicious page could drive
 * the agent surface from a logged-in browser.
 */
const handler = requireMcpAuth(
  auth,
  async (request, claims) => handleMcpRequest(request, callerFrom(claims)),
  {
    // Without this, requireMcpAuth defaults the resource to the auth base URL
    // (/api/auth), so the RFC 9728 challenge would advertise metadata for the
    // wrong resource and the client would never find this endpoint.
    resource: process.env.MCP_RESOURCE,
    // Coarse floor. Per-tool scopes are enforced inside the tools themselves.
    requiredScopes: ["profile:read"],
  },
);

export { handler as GET, handler as POST, handler as DELETE };
