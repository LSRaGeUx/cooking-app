import { requireMcpAuth } from "@better-auth/mcp";
import type { JWTPayload } from "jose";
import { auth } from "@/lib/auth";
import { mcpResource } from "@/lib/config";
import { handleMcpRequest, type McpCallerContext } from "@/mcp/server";

/** OAuth scope claims are a single space-delimited string (RFC 8693). */
function parseScopes(claims: JWTPayload): ReadonlySet<string> {
  const raw = claims["scope"];
  if (typeof raw !== "string") return new Set();
  return new Set(raw.split(" ").filter(Boolean));
}

/**
 * `null` rather than a thrown Error when the token carries no subject.
 *
 * It used to throw a bare `Error` from inside the authenticated handler, which
 * Next turned into an opaque 500: a client holding a structurally broken token
 * was told the server was broken. It is an authentication failure and it answers
 * as one, in the JSON-RPC shape the rest of this endpoint speaks.
 */
function callerFrom(claims: JWTPayload): McpCallerContext | null {
  const userId = claims.sub;
  if (!userId) return null;

  const clientId = claims["client_id"] ?? claims["azp"];
  return {
    userId,
    clientId: typeof clientId === "string" ? clientId : null,
    scopes: parseScopes(claims),
  };
}

/**
 * The headers a browser-hosted MCP client needs to preflight.
 *
 * There was no OPTIONS handler and no CORS headers at all, so a client running
 * in a page could not reach this endpoint: the preflight failed and the real
 * request was never sent. `Mcp-Session-Id` and `Mcp-Protocol-Version` are the
 * two headers Streamable HTTP defines, and they have to be allowed by name
 * because a wildcard is not honoured for a credentialed request.
 *
 * The origin is open because the credential is a bearer token, never the session
 * cookie: there is no ambient authority for another origin to borrow, which is
 * the same reasoning that makes this endpoint bearer-only in the first place.
 */
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-allow-headers":
    "Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  "access-control-expose-headers": "Mcp-Session-Id, WWW-Authenticate",
  "access-control-max-age": "86400",
} as const;

function unauthorized(message: string): Response {
  return Response.json(
    {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32001, message },
    },
    {
      status: 401,
      headers: {
        ...CORS_HEADERS,
        "cache-control": "no-store",
      },
    },
  );
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
  async (request, claims) => {
    const caller = callerFrom(claims);
    if (!caller) {
      return unauthorized(
        "Le jeton d'accès ne porte pas de sujet (claim `sub`), donc il ne " +
          "désigne aucun compte. Réautorisez le client pour obtenir un jeton valide.",
      );
    }
    return handleMcpRequest(request, caller);
  },
  {
    // Without this, requireMcpAuth defaults the resource to the auth base URL
    // (/api/auth), so the RFC 9728 challenge would advertise metadata for the
    // wrong resource and the client would never find this endpoint.
    resource: mcpResource(),
    // Coarse floor. Per-tool scopes are enforced inside the tools themselves.
    //
    // It is a floor rather than a per-tool gate, so a token holding only
    // `recipes:read` is refused at the door with `insufficient_scope` and never
    // reaches `search_recipes`, which would have accepted it. Every consent
    // screen this application drives asks for `profile:read`, so the case only
    // arises for a client that deliberately requested a narrower set.
    requiredScopes: ["profile:read"],
  },
);

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export { handler as GET, handler as POST, handler as DELETE };
