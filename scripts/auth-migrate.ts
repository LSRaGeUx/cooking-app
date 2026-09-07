// Better Auth owns its own tables. Rather than hand-syncing the auth and OAuth
// tables into the Drizzle schema on every upgrade, we run Better Auth's own
// migrator from the installed version, so no CLI version skew is possible.
import "dotenv/config";
import { getMigrations } from "better-auth/db/migration";
import { Pool } from "pg";
import { auth } from "../src/lib/auth";
import { ownerDatabaseUrl } from "../src/lib/config";

/**
 * The one place that needs the owner role, and the reason `src/lib/auth.ts` no
 * longer does.
 *
 * `auth.options` carries the pool that module built, which is now the runtime
 * role: `NOBYPASSRLS`, with DML on every table and the right to create none.
 * Creating a table with it fails, so the migration runs on a pool of its own
 * and every other option is inherited unchanged.
 *
 * Overriding `database` here rather than reaching for the owner URL in
 * `src/lib/auth.ts` is what keeps owner credentials out of the serving process,
 * which is what CLAUDE.md asks for: the owner URL is for migrations, and this
 * file is a migration.
 */
const owner = new Pool({ connectionString: ownerDatabaseUrl() });

const plan = await getMigrations({ ...auth.options, database: owner });

const created = plan.toBeCreated.map((t) => t.table);
const altered = plan.toBeAdded.map((t) => t.table);

if (
  created.length === 0 &&
  altered.length === 0 &&
  plan.toBeAddedIndexes.length === 0
) {
  console.log("auth-migrate: schema already up to date");
  process.exit(0);
}

if (plan.unsafeChanges.length > 0) {
  console.error(
    "auth-migrate: refused unsafe changes:\n" + plan.unsafeChanges.join("\n"),
  );
  process.exit(1);
}

console.log(
  `auth-migrate: creating ${created.length} tables: ${created.join(", ") || "none"}`,
);
console.log(
  `auth-migrate: altering ${altered.length} tables: ${altered.join(", ") || "none"}`,
);
console.log(`auth-migrate: adding ${plan.toBeAddedIndexes.length} indexes`);

await plan.runMigrations();
console.log("auth-migrate: done");
process.exit(0);
