// Creates the least-privileged runtime role and its grants. Idempotent.
// Runs as the owner role (DATABASE_URL) before any migration.
//
// The runtime role credential is taken from APP_DATABASE_URL rather than written
// into the SQL, so it stays out of version control and cannot drift from what the
// app actually connects with.
import "dotenv/config";
import { applyBootstrap, passwordOf } from "./lib/db.mjs";

const ownerUrl = process.env.DATABASE_URL;
const appUrl = process.env.APP_DATABASE_URL;

if (!ownerUrl || !appUrl) {
  console.error(
    "DATABASE_URL and APP_DATABASE_URL must both be set. Copy .env.example to .env.",
  );
  process.exit(1);
}

const pw = passwordOf(appUrl);
if (!pw) {
  console.error("APP_DATABASE_URL carries no credential for the runtime role.");
  process.exit(1);
}

await applyBootstrap(ownerUrl, pw);
console.log("bootstrap: role cooking_app and grants are in place");
