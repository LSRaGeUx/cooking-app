import { defineConfig } from "drizzle-kit";

// Drizzle owns the domain tables only. Better Auth owns its own tables and
// migrates them with its own migrator (scripts/auth-migrate.mjs), so this
// config deliberately does not see them.
export default defineConfig({
  schema: "./src/db/schema",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://cooking:cooking@localhost:5432/cooking",
  },
  verbose: true,
  strict: true,
});
