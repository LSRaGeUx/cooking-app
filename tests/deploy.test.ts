import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { filesUnder } from "./helpers/files";

/**
 * What the deployment files have to say, pinned down here because none of it
 * fails in development and all of it fails on a server.
 *
 * Three defects are the reason this file exists, and all three shipped at once
 * because nothing in the suite read a deployment file:
 *
 * 1. Compose injects only the variables a service's `environment:` block names.
 *    A value in `.env` is available for interpolation on the right-hand side and
 *    does not otherwise reach the process. `GOOGLE_CLIENT_ID`,
 *    `GOOGLE_CLIENT_SECRET` and `ALLOWED_EMAILS` were named nowhere, so the
 *    container could not offer a way to sign in.
 * 2. The build stage of the Dockerfile set placeholders for everything except a
 *    sign-in method, and `next build` imports the auth module to collect route
 *    data for /api/auth/[...all]. The image had never built.
 * 3. The migrator imports that same module, and had only the database URLs, so
 *    `up` stopped at the migrator before the application was ever started.
 */

const root = join(import.meta.dirname, "..");
const compose = readFileSync(join(root, "compose.yaml"), "utf8");
const dockerfile = readFileSync(join(root, "Dockerfile"), "utf8");

/**
 * Comments are stripped before any assertion that something is absent, because
 * the reason a setting is absent is written in a comment right next to where it
 * would have gone.
 */
function settingsOnly(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
}

/**
 * The block for one service, from its key to the next one at the same
 * indentation. Regex rather than a YAML parser on purpose: the only one
 * available is a transitive dependency, and a test that silently stops parsing
 * is worse than no test.
 */
function serviceBlock(name: string): string {
  const start = compose.indexOf(`\n  ${name}:\n`);
  expect(start, `compose.yaml has no ${name} service`).toBeGreaterThan(-1);
  const rest = compose.slice(start + 1);
  const next = rest.search(/\n(?: {2}[a-z]|[a-z])/);
  return next === -1 ? rest : rest.slice(0, next);
}

/**
 * What importing `src/lib/auth.ts` needs. Both the application and the migrator
 * import it, so both get this block, and the shared anchor is what keeps that
 * true.
 */
const AUTH_VARS = [
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "MCP_RESOURCE",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
] as const;

/** Read per request rather than at import, so the migrator has no use for it. */
const APP_ONLY_VARS = ["ALLOWED_EMAILS"] as const;

/** Reaches both services through the other anchor. */
const DB_VARS = ["DATABASE_URL", "APP_DATABASE_URL"] as const;

/**
 * Read only by development commands, or supplied by the runtime itself. A
 * variable in none of these lists fails the last test in this file, which is
 * the point: adding one to the application should force the question of whether
 * a container needs it.
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

describe("compose.yaml, the environment the containers get", () => {
  it.each([...AUTH_VARS, ...APP_ONLY_VARS])("names %s at all", (name) => {
    expect(compose).toContain(`${name}: \${${name}`);
  });

  /**
   * The two credentials a deployment may mount as a file instead of a variable.
   *
   * `deploy/compose.secrets.yaml` supplies them as `<NAME>_FILE`, and Compose
   * interpolates every file it is handed whichever profile is active, so a `:?`
   * guard in `compose.yaml` would refuse the overlay before it could supply the
   * value. The guard therefore lives in `secret()` in `src/lib/config.ts`,
   * which the next test pins.
   */
  const FILE_BACKED = new Set(["BETTER_AUTH_SECRET", "GOOGLE_CLIENT_SECRET"]);

  it.each(
    [...AUTH_VARS, ...APP_ONLY_VARS].filter((name) => !FILE_BACKED.has(name)),
  )("refuses to start without %s", (name) => {
    // `:?` rather than `:-`: every one of these fails quietly if it is wrong,
    // so the deployment should not come up at all rather than come up broken.
    expect(compose).toMatch(new RegExp(`${name}: \\$\\{${name}:\\?`));
  });

  it.each([...FILE_BACKED])(
    "lets the secrets overlay supply %s as a file",
    (name) => {
      // Spelled `:-` on purpose, so the overlay can reach it. A `:?` here would
      // refuse the overlay before it could mount the file.
      expect(compose).toMatch(new RegExp(`${name}: \\$\\{${name}:-`));

      // And the file form is actually wired, in the overlay and in the reader.
      const overlay = readFileSync(
        join(root, "deploy", "compose.secrets.yaml"),
        "utf8",
      );
      expect(overlay).toContain(`${name}_FILE`);

      const config = readFileSync(
        join(root, "src", "lib", "config.ts"),
        "utf8",
      );
      expect(config).toContain("_FILE");
    },
  );

  it("still refuses to start without BETTER_AUTH_SECRET, in the application", () => {
    // The guarantee the `:?` used to give, relocated rather than dropped.
    // `secret()` throws naming both spellings, and it is evaluated in the
    // `betterAuth({...})` literal at module top level. The migrator imports
    // that module and runs before the application, so a deployment missing the
    // secret fails before anything serves a request.
    const auth = readFileSync(join(root, "src", "lib", "auth.ts"), "utf8");
    expect(auth).toContain('secret("BETTER_AUTH_SECRET")');
  });

  it.each(DB_VARS)("builds %s from the container credentials", (name) => {
    expect(compose).toContain(`${name}: postgres://`);
  });

  it("gives the app both blocks", () => {
    expect(serviceBlock("app")).toContain("<<: [*db_env, *auth_env]");
  });

  it("gives the migrator both blocks as well", () => {
    // scripts/auth-migrate.ts imports src/lib/auth.ts, which validates its
    // configuration at import time. A migrator with only the database URLs
    // fails there, and `up` stops before the application is ever started.
    expect(serviceBlock("migrate")).toContain("<<: [*db_env, *auth_env]");
  });

  it("gives the allowlist to the app and not to the migrator", () => {
    expect(serviceBlock("app")).toContain("ALLOWED_EMAILS");
    expect(settingsOnly(serviceBlock("migrate"))).not.toContain(
      "ALLOWED_EMAILS",
    );
  });

  it("never passes the password sign-in flag to anything", () => {
    // The endpoints it opens exist for `npm run verify:oauth`. A container
    // facing the internet has no business answering them, whatever .env says.
    expect(settingsOnly(compose)).not.toContain("AUTH_PASSWORD_LOGIN");
  });
});

describe("compose.yaml, the rest", () => {
  it("polls an endpoint that proves the database is reachable", () => {
    expect(serviceBlock("app")).toContain("/api/health");
  });

  it("publishes the app on loopback only, since TLS is terminated upstream", () => {
    expect(serviceBlock("app")).toMatch(/"127\.0\.0\.1:3000:3000"/);
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

describe("the Dockerfile build stage", () => {
  const build = dockerfile.slice(
    dockerfile.indexOf("AS build"),
    dockerfile.indexOf("AS migrator"),
  );

  it.each([
    "DATABASE_URL",
    "APP_DATABASE_URL",
    "BETTER_AUTH_SECRET",
    "MCP_RESOURCE",
  ])(
    "sets a placeholder for %s, which the auth module reads at import",
    (name) => {
      expect(build).toContain(`${name}=`);
    },
  );

  it("sets a placeholder sign-in method", () => {
    // `next build` collects route data for /api/auth/[...all], and the auth
    // module refuses a configuration with no way in at all. Without this the
    // image does not build at all.
    expect(build).toContain("GOOGLE_CLIENT_ID=");
    expect(build).toContain("GOOGLE_CLIENT_SECRET=");
  });

  it("keeps the placeholders out of the runtime stage", () => {
    const runtime = dockerfile.slice(dockerfile.indexOf("AS runtime"));
    expect(runtime).not.toContain("placeholder");
    expect(runtime).not.toContain("DATABASE_URL");
  });

  it("runs the server as a user that is not root", () => {
    expect(dockerfile).toContain("USER node");
  });
});

describe("the TLS overlay", () => {
  const overlay = readFileSync(
    join(root, "deploy", "compose.proxy.yaml"),
    "utf8",
  );
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

/**
 * The server pulls what CI pushed, and the only thing connecting the two is a
 * tag spelled out in two files. Nothing catches a disagreement: Compose reports
 * a missing image as a pull failure, which reads like a registry or credentials
 * problem rather than a typo.
 */
describe("the images a server pulls", () => {
  const workflow = readFileSync(
    join(root, ".github", "workflows", "ci.yml"),
    "utf8",
  );

  /** The tag on a service, e.g. `${IMAGE_REPO:-...}:${IMAGE_TAG:-main}-runtime`. */
  function imageLine(service: string): string {
    const match = serviceBlock(service).match(/^\s*image:\s*(\S+)\s*$/m);
    expect(
      match,
      `compose.yaml gives ${service} no image, so a server has nothing to pull`,
    ).not.toBeNull();
    return match![1]!;
  }

  it.each(["app", "migrate"])(
    "gives %s an image as well as a build",
    (service) => {
      // Both, not either: `build:` is for CI and for hacking locally, `image:` is
      // for every machine that must not build.
      expect(imageLine(service)).toContain("ghcr.io/");
      expect(serviceBlock(service)).toContain("target:");
    },
  );

  it.each(["app", "migrate"])("lets a self-hoster repoint %s", (service) => {
    // A hardcoded registry path makes this deployable by one account only.
    expect(imageLine(service)).toMatch(/\$\{IMAGE_REPO:-/);
    expect(imageLine(service)).toMatch(/\$\{IMAGE_TAG:-/);
  });

  it("defaults to a lowercase registry path", () => {
    // GHCR rejects an uppercase path outright, and the account this publishes
    // from is spelled with capitals.
    const path = imageLine("app").replace(/\$\{[^}]+\}/g, "");
    expect(path).toBe(path.toLowerCase());
  });

  it("does not hand the application the migrator image", () => {
    // One package, two tags, so the difference is a suffix, and a copy-paste
    // between two adjacent services is invisible until the wrong thing boots.
    expect(imageLine("app")).not.toBe(imageLine("migrate"));
  });

  it.each(["app", "migrate"])(
    "names a tag CI actually pushes, for %s",
    (service) => {
      const suffix = imageLine(service).match(/}(-[a-z]+)$/)?.[1];
      expect(
        suffix,
        `the image for ${service} has no -suffix to match against CI`,
      ).toBeTruthy();
      expect(workflow).toContain(`:main${suffix}`);
      expect(workflow).toContain(`}${suffix}`);
    },
  );

  it("publishes an immutable tag next to the moving one, so a rollback exists", () => {
    expect(workflow).toContain("sha-${GITHUB_SHA::7}");
  });

  it("builds for the architecture a VPS has, not the one a Mac has", () => {
    expect(workflow).toContain("platforms: linux/amd64");
  });

  it("pushes nothing that has not passed both other jobs", () => {
    expect(workflow).toContain("needs: [verify, deploy]");
    expect(workflow).toContain("github.ref == 'refs/heads/main'");
  });

  it("never documents a pull without the profile that holds the images", () => {
    // Found on the first real deploy. Both application services are in the
    // `serve` profile, so a bare `docker compose pull` considers only the
    // database, pulls it, and reports success without mentioning the two it
    // skipped. The `up` that follows fails on a missing image, which reads like
    // a registry or credentials problem and sends you looking in the wrong place.
    const docs = ["README.md", "CLAUDE.md", join("docs", "08-self-hosting.md")];
    for (const file of [...docs, join(".github", "workflows", "ci.yml")]) {
      // Prose wraps, so the command can straddle two lines and a line-by-line
      // scan misses it. That is how the one in CLAUDE.md survived the first fix.
      const text = readFileSync(join(root, file), "utf8").replace(/\s+/g, " ");
      const bare = [
        ...text.matchAll(/docker compose\b([^`\n]*?)\bpull\b/g),
      ].filter((match) => !match[1]!.includes("--profile serve"));
      expect(
        bare.map((match) => match[0]),
        `${file} documents a pull that would silently skip the app`,
      ).toEqual([]);
    }
  });
});

/**
 * The four names `scripts/lib/db.mjs` assembles from a prefix rather than
 * writing out: `env[`${prefix}_DATABASE_URL`]` and its three siblings. No search
 * for the literal name finds them, so the staleness check below cannot judge
 * them and says so here instead of quietly passing them.
 */
const DERIVED_VARS = new Set([
  "TEST_DATABASE_URL",
  "TEST_APP_DATABASE_URL",
  "VERIFY_DATABASE_URL",
  "VERIFY_APP_DATABASE_URL",
]);

/**
 * Every variable name `src/` reads, by the scan the test below documents.
 * Hoisted out of that test because two of them need it.
 */
function variablesReadBySource(): Set<string> {
  const read = new Set<string>();

  /**
   * Every environment variable is now resolved in `src/lib/config.ts`, and
   * ESLint fails the build on `process.env` anywhere else in `src/`. So the
   * names live in that one file, as string literals passed to its four
   * readers, and scanning the whole tree for `process.env.NAME` finds almost
   * nothing: the reads inside config.ts itself go through `process.env[name]`
   * with a variable, which no regex can resolve.
   *
   * That is a better scan target, not a worse one. One file, four call
   * shapes, and a lint rule that keeps it the only file worth scanning. The
   * sanity assertion below is what would have caught the previous version of
   * this test going quietly blind: it found four names and passed.
   */
  const configPatterns = [
    /\brequired\("([A-Z0-9_]+)"\)/g,
    /\boptional\("([A-Z0-9_]+)"\)/g,
    /\bsecret\("([A-Z0-9_]+)"\)/g,
    /\boptionalSecret\("([A-Z0-9_]+)"\)/g,
    /requiredInProduction\("([A-Z0-9_]+)"/g,
    /\bread\("([A-Z0-9_]+)"\)/g,
  ];
  const configText = readFileSync(
    join(root, "src", "lib", "config.ts"),
    "utf8",
  );
  for (const pattern of configPatterns) {
    for (const match of configText.matchAll(pattern)) {
      const name = match[1];
      if (name) read.add(name);
    }
  }

  // The two files ESLint exempts, because they read NODE_ENV, which the
  // bundler inlines and which no container needs to be told.
  for (const file of filesUnder(join(root, "src"))) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
      const name = match[1];
      if (name) read.add(name);
    }
  }

  return read;
}

describe("every variable the application reads", () => {
  it("is either passed to a container or marked as not for one", () => {
    const read = variablesReadBySource();

    // Sanity: a scan that found nothing, or that has stopped being able to see
    // where the names are, would pass the assertion below without checking
    // anything. This is the guard on the scan itself.
    expect(
      read.size,
      "The environment scan found almost nothing, which means it has gone " +
        "blind rather than that the application reads nothing. Check whether " +
        "src/lib/config.ts still spells its variable names as string literals.",
    ).toBeGreaterThan(8);

    const known = new Set<string>([
      ...AUTH_VARS,
      ...APP_ONLY_VARS,
      ...DB_VARS,
      ...NOT_CONTAINER_VARS,
    ]);
    const unclassified = [...read].filter((name) => !known.has(name)).sort();

    expect(
      unclassified,
      "A new environment variable reached src/ without a decision about the " +
        "containers. Add it to compose.yaml and to the matching list in this " +
        "file, or to NOT_CONTAINER_VARS if it is development only.",
    ).toEqual([]);
  });

  /**
   * The list only ever grew. `NOT_CONTAINER_VARS` is checked in one direction,
   * "is this name classified", and never in the other, so a variable that stops
   * being read anywhere stays on it for ever and the next reader takes it for a
   * live setting. That is how the list becomes documentation of a configuration
   * that no longer exists.
   */
  it("has no entry in NOT_CONTAINER_VARS that nothing reads any more", () => {
    const inSource = variablesReadBySource();
    const scripts = filesUnder(join(root, "scripts"), [".mjs", ".ts", ".js"])
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    const nextConfig = readFileSync(join(root, "next.config.ts"), "utf8");

    const stale = [...NOT_CONTAINER_VARS]
      .filter((name) => !DERIVED_VARS.has(name))
      .filter(
        (name) =>
          !inSource.has(name) &&
          !scripts.includes(name) &&
          !nextConfig.includes(name),
      )
      .sort();

    expect(
      stale,
      "These names are marked as development only and are now read by " +
        "nothing in src/, scripts/ or next.config.ts. Delete them from " +
        "NOT_CONTAINER_VARS, or add them to DERIVED_VARS if the name is " +
        "assembled from a prefix rather than written out.",
    ).toEqual([]);
  });

  it("assembles the four derived names where it says it does", () => {
    // The escape hatch above, checked. If db.mjs stops building these from a
    // prefix, DERIVED_VARS becomes an unjustified exemption rather than a
    // documented one.
    const db = readFileSync(join(root, "scripts", "lib", "db.mjs"), "utf8");
    expect(db).toContain("_DATABASE_URL`");
    expect(db).toContain("_APP_DATABASE_URL`");
  });
});

/**
 * The Node version, in the three places it is written.
 *
 * None of these disagreeing fails in development. `.nvmrc` decides what a
 * developer runs, `engines.node` decides what `npm ci` refuses, and the
 * Dockerfile decides what the image runs, so a drift between them is a
 * difference between the laptop and the server with nothing announcing it.
 */
describe("the Node version", () => {
  const nvmrc = readFileSync(join(root, ".nvmrc"), "utf8").trim();
  const packageJson = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  ) as { engines?: { node?: string } };

  it("is a plain version in .nvmrc", () => {
    expect(nvmrc).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("agrees with engines.node in package.json", () => {
    // `^26.3.0` and `26.3.0`: the range's floor is the pinned version, so a
    // developer on .nvmrc is never below what `npm ci` requires.
    expect(packageJson.engines?.node).toBe(`^${nvmrc}`);
  });

  it("agrees with the base image the Dockerfile pins", () => {
    /*
     * The Dockerfile pins by digest, because `node:26.3-alpine` is republished
     * whenever its Alpine base is patched and the same commit would otherwise
     * rebuild into a different image. A digest tells a human nothing, so the
     * readable tag stays in the comment beside it, and that tag is what this
     * reads: it is the only machine-checkable link between the pin and .nvmrc.
     */
    const [major, minor] = nvmrc.split(".");
    expect(dockerfile).toContain(`node:${major}.${minor}-alpine`);
    expect(dockerfile).toMatch(/ARG NODE_IMAGE=node@sha256:[0-9a-f]{64}/);
  });
});

/**
 * The build context, which decides what can end up in a layer.
 *
 * A `.dockerignore` is the only thing keeping `.env` out, and an image that
 * carried one would carry the database password and the auth secret into
 * whatever registry it is pushed to, readable by anyone who can pull it. The
 * file says as much in its first comment; this is the assertion behind it.
 */
describe(".dockerignore", () => {
  const dockerignore = readFileSync(join(root, ".dockerignore"), "utf8");
  const entries = dockerignore
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));

  it.each([".env", ".env.*"])(
    "keeps %s out of the build context",
    (pattern) => {
      expect(entries).toContain(pattern);
    },
  );

  it("keeps the local Postgres data and the git history out too", () => {
    // Not secrets, but both are large enough that including one turns every
    // build into a multi-gigabyte context upload.
    expect(entries).toContain(".git");
    expect(entries).toContain("node_modules");
    expect(entries).toContain(".next");
  });

  it("does not exclude anything the build actually copies", () => {
    // The build stage copies package.json, the lockfile, src/, drizzle/ and the
    // config files. Excluding one of those produces a build failure that reads
    // as a missing file rather than as an ignore rule, which is a bad afternoon.
    for (const needed of [
      "package.json",
      "package-lock.json",
      "src",
      "drizzle",
      "messages",
      "public",
    ]) {
      expect(entries, `.dockerignore excludes ${needed}`).not.toContain(needed);
    }
  });
});
