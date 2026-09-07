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
/**
 * Report-only for now, and deliberately so. The comment on `headers()` below
 * used to record the absence of any policy as a known gap; this is the half of
 * it that can ship without changing how every page renders.
 *
 * Report-only means the browser evaluates the policy, blocks nothing, and logs
 * each violation to the console (and to a reporting endpoint, if one is ever
 * configured with `Reporting-Endpoints` and a `report-to` directive). So it
 * costs nothing to be wrong, and it answers the question that has to be
 * answered before enforcing: which sources does this application actually use.
 *
 * What has to change to enforce it, in order:
 *
 * 1. `script-src` and `style-src` lose `'unsafe-inline'` and gain
 *    `'nonce-<value>' 'strict-dynamic'`. Next inlines its own bootstrap script,
 *    so nothing works without one of the two.
 * 2. The nonce is per request, which means a `proxy.ts` at the project root
 *    that generates one, sets it on the request as `x-nonce` and in the CSP
 *    header, per the guide in
 *    node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md.
 *    Next then attaches it to the framework scripts by itself.
 * 3. Every page becomes dynamically rendered, because a nonce cannot exist at
 *    build time. That is the real cost, and it is why this is not one commit.
 * 4. The header key drops `-Report-Only`.
 *
 * `'unsafe-inline'` is in here rather than left out on purpose. Without it,
 * every single page load reports the Next bootstrap script, and a hundred
 * expected violations hide the one that matters.
 *
 * `img-src` allows any https host because recipe images are addresses on other
 * people's servers, which is the whole import feature. `upgrade-insecure-requests`
 * is absent because it is one of the directives a report-only policy ignores.
 */
const cspReportOnly = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${
    process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""
  }`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self'",
  // The service worker in public/sw.js, and the installed application's manifest.
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  // The same statement as X-Frame-Options: DENY below, for browsers that read
  // this one instead.
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  // Constraint 1 from CLAUDE.md: no server-side LLM. Nothing here may add an
  // outbound AI client. See scripts/check-no-llm-deps.mjs.
  serverExternalPackages: ["pg"],

  // Off. It announces the framework and its major version on every response,
  // which is free reconnaissance and buys nothing.
  poweredByHeader: false,

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

  /**
   * The headers that belong to the application rather than to whatever proxy is
   * in front of it. Strict-Transport-Security is not here on purpose: it is only
   * meaningful on a request that already arrived over TLS, and TLS is terminated
   * upstream, so `deploy/Caddyfile` sends it.
   *
   * The Content-Security-Policy is report-only, which is as far as it goes
   * without per-request nonces and therefore without making every page
   * dynamic. What it takes to enforce it is written out above `cspReportOnly`.
   */
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Content-Security-Policy-Report-Only", value: cspReportOnly },
          // Recipe images are addresses on other people's hosts, rendered in the
          // reader's browser. This sends them the origin and never the path, so
          // an image host learns that this instance exists and not which recipe
          // was open.
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // Nothing in this application is meant to be embedded, and the consent
          // screen least of all: an agent that could frame it could dress it up
          // as something else.
          { key: "X-Frame-Options", value: "DENY" },
          // allow-popups rather than same-origin, so a sign-in opened in a popup
          // can still talk to the window that opened it.
          {
            key: "Cross-Origin-Opener-Policy",
            value: "same-origin-allow-popups",
          },
          {
            key: "Permissions-Policy",
            value:
              "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
          },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
