import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Order matters. dotenv/config fills the environment, then the second file
    // redirects the two database URLs at the test database, and both run before
    // a test file imports src/db/client.ts and opens its pool.
    setupFiles: ["dotenv/config", "./tests/setup/test-database.ts"],
    // Empties that database once, so a run that failed half way through does not
    // decide what the next one sees.
    globalSetup: ["./tests/setup/global.ts"],
    // Integration tests share one Postgres, so no parallel file execution.
    fileParallelism: false,
    testTimeout: 20000,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
