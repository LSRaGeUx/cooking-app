import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    /**
     * What the suite runs with, pinned rather than inherited.
     *
     * These reach the worker's `process.env` before anything in it imports
     * `src/`, and they win over `.env`: dotenv never overwrites a variable that
     * is already set. That direction is the whole point. `dotenv/config` below
     * is still needed, because DATABASE_URL and APP_DATABASE_URL are per
     * machine and the sibling names are derived from them, but everything that
     * decides how the application behaves is decided here, so the suite cannot
     * pass on one developer's machine and fail on another's.
     *
     * The values are the ones the CI job sets, so local and CI agree by
     * construction rather than by coincidence.
     *
     * TZ is the reason this block exists at all. Several domain tests build a
     * date with `Date.UTC` and compare it against one built from local
     * midnight, which agrees only where the runner happens to sit on UTC.
     * Pinning it makes the run reproducible in every zone. It works because the
     * default pool spawns a worker process, and Node reads TZ at startup.
     *
     * Empty is not the same as unset for GOOGLE_CLIENT_ID and
     * GOOGLE_CLIENT_SECRET, but both are read for truthiness, so an empty value
     * is what "no Google client configured" looks like, whatever the developer
     * has in .env. AUTH_PASSWORD_LOGIN is then the way in that keeps the auth
     * module from refusing a configuration with no sign-in method at all.
     */
    env: {
      TZ: "UTC",
      ALLOWED_EMAILS: "",
      AUTH_PASSWORD_LOGIN: "true",
      BETTER_AUTH_SECRET: "test-secret-not-used-in-production",
      BETTER_AUTH_URL: "http://localhost:3000",
      MCP_RESOURCE: "http://localhost:3000/api/mcp",
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
    },
    // Order matters. dotenv/config fills the environment, then the others
    // correct it: the database URLs are redirected at the test database, and the
    // allowlist is emptied so the developer's own does not decide what passes.
    // All of it runs before a test file imports src/db/client.ts and opens its
    // pool.
    setupFiles: [
      "dotenv/config",
      "./tests/setup/test-database.ts",
      "./tests/setup/instance-access.ts",
    ],
    // ...and Vitest documents this as running them in parallel by default, so
    // the order above is pinned rather than left to what the installed version
    // happens to do.
    sequence: { setupFiles: "list" },
    // Empties that database before the run and before every rerun, so a run that
    // failed half way through does not decide what the next one sees.
    globalSetup: ["./tests/setup/global.ts"],
    // Integration tests share one Postgres, so no parallel file execution.
    fileParallelism: false,
    testTimeout: 20000,
    /**
     * Coverage of `src/` only. The tests directory covering itself is not
     * information, and scripts/ is not typechecked or imported by the suite.
     *
     * The thresholds are set from what the suite actually reaches, rounded
     * down, so the gate is real without being red on the day it lands. They are
     * a ratchet: raise them when coverage rises, and never lower one to make a
     * change pass. The seven rules in CLAUDE.md are what the number is for, and
     * `npm run test:coverage` prints the HTML report that says which branch of
     * an allergen or tenancy guard is still unvisited.
     */
    coverage: {
      provider: "v8",
      // Scoped to the two source extensions rather than `src/**`. The provider
      // also loads every *uncovered* file it is pointed at, and it parses each
      // one as JavaScript: `src/app/globals.css` and `src/db/bootstrap.sql` both
      // make it throw, and the run then produces no report at all.
      include: ["src/**/*.{ts,tsx}"],
      reporter: ["text", "html"],
      // A failing run is exactly the run whose coverage you want to look at,
      // and the default is to throw the measurement away.
      reportOnFailure: true,
      //
      // Measured, not guessed: 43.5% of statements, 36.9% of branches, 36.6% of
      // functions and 44.2% of lines, with 328 of 338 tests passing. So a green
      // suite is at or above these, and the margin is about a point and a half.
      //
      // The whole of src/app and src/components is 0, because this suite runs in
      // Node and renders nothing, and that is most of the file count. Where the
      // seven rules actually live the numbers are the ones to read: src/domain
      // is at 88% of lines, src/services at 84%.
      //
      // Only `npm run test:coverage` evaluates these. `npm test`, and therefore
      // `npm run verify`, runs without the provider, so a threshold cannot fail
      // a run that has nothing to do with coverage.
      thresholds: {
        // Measured at 54.26 / 43.84 / 50.48 / 55.21 with 621 tests, then
        // rounded down a couple of points so an ordinary change does not turn
        // the gate red for no reason. Raise them when coverage rises.
        statements: 52,
        branches: 42,
        functions: 48,
        lines: 53,
      },
    },
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
