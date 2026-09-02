import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * What the deployment files have to say, pinned down here because none of it
 * fails in development.
 *
 * The bug this file exists for: Compose injects only the variables a service's
 * `environment:` block names. A value in `.env` is available for interpolation
 * on the right-hand side and does not otherwise reach the process. The
 * container path shipped for a while with `GOOGLE_CLIENT_ID`,
 * `GOOGLE_CLIENT_SECRET` and `ALLOWED_EMAILS` missing from that block, so it
 * could not offer a way to sign in at all, and nothing in the suite noticed
 * because nothing in the suite reads compose.yaml.
 */

const root = join(import.meta.dirname, "..");
const compose = readFileSync(join(root, "compose.yaml"), "utf8");

/**
 * Comments are stripped before any assertion that something is absent, because
 * the reason a setting is absent is written in a comment right next to where it
 * would have gone.
 */
function settingsOnly(yaml: string): string {
  return yaml
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
}

/**
 * The block for one service, from its key to the next one at the same
 * indentation. Regex rather than a YAML parser on purpose: the only dependency
 * available is a transitive one, and a test that silently stops parsing is
 * worse than no test.
 */
function serviceBlock(name: string): string {
  const start = compose.indexOf(`\n  ${name}:\n`);
  expect(start, `compose.yaml has no ${name} service`).toBeGreaterThan(-1);
  const rest = compose.slice(start + 1);
  const next = rest.search(/\n(?: {2}[a-z]|[a-z])/);
  return next === -1 ? rest : rest.slice(0, next);
}

/**
 * Every variable the running container must receive. `DATABASE_URL` and
 * `APP_DATABASE_URL` arrive through the `db_env` anchor rather than by name in
 * the app block, so they are checked against the whole file.
 */
const CONTAINER_VARS = [
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "MCP_RESOURCE",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "ALLOWED_EMAILS",
] as const;

/**
 * Read only by development commands, or supplied by the runtime itself. A
 * variable in neither this list nor the one above fails the scan below, which is
 * the point: adding one to the application should force the question of whether
 * the container needs it.
 */
const NOT_CONTAINER_VARS = new Set([
  "NODE_ENV",
  "NEXT_DIST_DIR",
  "AUTH_PASSWORD_LOGIN",
  "TEST_DATABASE_URL",
  "TEST_APP_DATABASE_URL",
  "VERIFY_DATABASE_URL",
  "VERIFY_APP_DATABASE_URL",
  "DEV_TEST_PORT",
  "VERIFY_BASE_URL",
  "VERIFY_EMAIL",
  "VERIFY_PASSWORD",
]);

const DB_VARS = ["DATABASE_URL", "APP_DATABASE_URL"] as const;

describe("compose.yaml, the app service", () => {
  const app = serviceBlock("app");

  it.each(CONTAINER_VARS)("passes %s through to the container", (name) => {
    expect(app).toContain(`${name}: \${${name}`);
  });

  it.each(CONTAINER_VARS)("refuses to start without %s", (name) => {
    // `:?` rather than `:-`: every one of these fails quietly if it is wrong, so
    // the deployment should not come up at all rather than come up broken.
    expect(app).toMatch(new RegExp(`${name}: \\$\\{${name}:\\?`));
  });

  it("never passes the password sign-in flag", () => {
    // The endpoints it opens exist for `npm run verify:oauth`. A container
    // facing the internet has no business answering them, whatever .env says.
    expect(settingsOnly(app)).not.toContain("AUTH_PASSWORD_LOGIN");
  });

  it("polls an endpoint that proves the database is reachable", () => {
    expect(app).toContain("/api/health");
  });

  it("publishes on loopback only, since TLS is terminated upstream", () => {
    expect(app).toMatch(/"127\.0\.0\.1:3000:3000"/);
  });
});

describe("compose.yaml, the rest", () => {
  it.each(DB_VARS)("hands %s to both the app and the migrator", (name) => {
    expect(compose).toContain(`${name}: postgres://`);
  });

  it("keeps Postgres off every interface but loopback", () => {
    expect(serviceBlock("db")).toMatch(/"127\.0\.0\.1:5432:5432"/);
  });

  it("caps container logs, which are what fills a small disk first", () => {
    expect(compose).toContain("max-size:");
    expect(compose).toContain("max-file:");
  });

  it("runs the migrator to completion before the app starts", () => {
    expect(serviceBlock("app")).toContain("service_completed_successfully");
  });

  it("leaves TLS to the overlay, so a dev command needs no public hostname", () => {
    // A required APP_DOMAIN in this file would make `npm run db:up` demand one:
    // Compose interpolates every service whichever profile is selected.
    expect(settingsOnly(compose)).not.toContain("APP_DOMAIN");
  });
});

describe("the TLS overlay", () => {
  const overlay = readFileSync(join(root, "deploy", "compose.proxy.yaml"), "utf8");
  const caddyfile = readFileSync(join(root, "deploy", "Caddyfile"), "utf8");

  it("refuses to start without the hostname to certify", () => {
    expect(overlay).toMatch(/APP_DOMAIN: \$\{APP_DOMAIN:\?/);
  });

  it("keeps its certificates in a named volume", () => {
    // A fresh volume on every start means re-issuing on every start, which the
    // rate limits at Let's Encrypt eventually refuse.
    expect(overlay).toContain("caddy_data:/data");
    expect(overlay).toContain("caddy_data:\n  caddy_config:");
  });

  it("mounts the Caddyfile read-only", () => {
    expect(overlay).toContain("./deploy/Caddyfile:/etc/caddy/Caddyfile:ro");
  });

  it("forwards to the app with the path untouched", () => {
    // Two rewrites in next.config.ts are what let an MCP client discover the
    // authorization server. A handle block on /.well-known/ here would swallow
    // them and break the paste-one-URL connection story.
    expect(caddyfile).toContain("reverse_proxy app:3000");
    expect(settingsOnly(caddyfile)).not.toMatch(/handle[^\n]*\.well-known/);
  });

  it("sends HSTS, which the application cannot", () => {
    // The header is about the TLS this proxy terminates, so it is the only
    // place with the standing to send it.
    expect(caddyfile).toContain("Strict-Transport-Security");
  });
});

describe("every variable the application reads", () => {
  it("is either passed to the container or marked as not for it", () => {
    const read = new Set<string>();
    for (const file of sourceFiles(join(root, "src"))) {
      const text = readFileSync(file, "utf8");
      for (const [, name] of text.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
        if (name) read.add(name);
      }
      // src/lib/auth.ts reaches the environment through a helper, so the
      // property-access pattern above does not see the name.
      for (const [, name] of text.matchAll(/required\("([A-Z0-9_]+)"\)/g)) {
        if (name) read.add(name);
      }
    }

    // Sanity: a scan that found nothing would pass every assertion below.
    expect(read.size).toBeGreaterThan(5);

    const known = new Set<string>([...CONTAINER_VARS, ...DB_VARS, ...NOT_CONTAINER_VARS]);
    const unclassified = [...read].filter((name) => !known.has(name)).sort();

    expect(
      unclassified,
      "A new environment variable reached src/ without a decision about the " +
        "container. Add it to CONTAINER_VARS and to the app service in " +
        "compose.yaml, or to NOT_CONTAINER_VARS if it is development only.",
    ).toEqual([]);
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry) ? [path] : [];
  });
}
