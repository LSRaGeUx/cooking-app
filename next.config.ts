import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin();

/**
 * Better Auth mounts everything under /api/auth, so the OAuth issuer is
 * http://host/api/auth and it serves its own discovery documents under that
 * prefix. Two of the three discovery conventions do not look there:
 *
 * - RFC 8414 (OAuth AS metadata) inserts the well-known segment before the
 *   issuer path: {host}/.well-known/oauth-authorization-server/api/auth
 * - RFC 9728 (protected resource metadata) does the same for the resource:
 *   {host}/.well-known/oauth-protected-resource/api/mcp
 * - OpenID Connect Discovery appends instead: {issuer}/.well-known/
 *   openid-configuration, which Better Auth already answers natively.
 *
 * So exactly two rewrites are needed, and no more. These are load-bearing:
 * without them an MCP client cannot discover the authorization server and the
 * paste-one-URL connection story fails. Verified against the live endpoints.
 */
const nextConfig: NextConfig = {
  // Constraint 1 from CLAUDE.md: no server-side LLM. Nothing here may add an
  // outbound AI client. See scripts/check-no-llm-deps.mjs.
  serverExternalPackages: ["pg"],

  // `npm run dev:test` sets this, so a test server running beside `npm run dev`
  // does not share one build directory with it.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",

  // Emits .next/standalone, a self-contained server with only the traced
  // dependencies. It is what lets the runtime image skip npm and the whole
  // toolchain, which is most of the image and all of its attack surface.
  output: "standalone",

  // beforeFiles, so a well-known path can never be swallowed by a page route or
  // the 404 handler before the rewrite is considered.
  async rewrites() {
    return {
      beforeFiles: [
        {
          source: "/.well-known/oauth-authorization-server/:path*",
          destination: "/api/auth/.well-known/oauth-authorization-server",
        },
        {
          source: "/.well-known/oauth-protected-resource/:path*",
          destination: "/api/auth/.well-known/oauth-protected-resource/:path*",
        },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
};

export default withNextIntl(nextConfig);
