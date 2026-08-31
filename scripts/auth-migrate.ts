// Better Auth owns its own tables. Rather than hand-syncing the auth and OAuth
// tables into the Drizzle schema on every upgrade, we run Better Auth's own
// migrator from the installed version, so no CLI version skew is possible.
import "dotenv/config";
import { getMigrations } from "better-auth/db/migration";
import { auth } from "../src/lib/auth";

const plan = await getMigrations(auth.options);

const created = plan.toBeCreated.map((t) => t.table);
const altered = plan.toBeAdded.map((t) => t.table);

if (created.length === 0 && altered.length === 0 && plan.toBeAddedIndexes.length === 0) {
  console.log("auth-migrate: schema already up to date");
  process.exit(0);
}

if (plan.unsafeChanges.length > 0) {
  console.error("auth-migrate: refused unsafe changes:\n" + plan.unsafeChanges.join("\n"));
  process.exit(1);
}

console.log(`auth-migrate: creating ${created.length} tables: ${created.join(", ") || "none"}`);
console.log(`auth-migrate: altering ${altered.length} tables: ${altered.join(", ") || "none"}`);
console.log(`auth-migrate: adding ${plan.toBeAddedIndexes.length} indexes`);

await plan.runMigrations();
console.log("auth-migrate: done");
process.exit(0);
