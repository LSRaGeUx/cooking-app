// Creates the least-privileged runtime role and its grants. Idempotent.
// Runs as the owner role (DATABASE_URL) before any migration.
//
// The runtime role credential is taken from APP_DATABASE_URL rather than written
// into the SQL, so it stays out of version control and cannot drift from what the
// app actually connects with.
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import "dotenv/config";

const ownerUrl = process.env.DATABASE_URL;
const appUrl = process.env.APP_DATABASE_URL;

if (!ownerUrl || !appUrl) {
  console.error(
    "DATABASE_URL and APP_DATABASE_URL must both be set. Copy .env.example to .env.",
  );
  process.exit(1);
}

const pw = new URL(appUrl).password;
if (!pw) {
  console.error("APP_DATABASE_URL carries no credential for the runtime role.");
  process.exit(1);
}

const sql = await readFile(
  new URL("../src/db/bootstrap.sql", import.meta.url),
  "utf8",
);
const client = new Client({ connectionString: ownerUrl });

await client.connect();
try {
  // Bound, not interpolated, and the SQL quotes it with format(%L).
  await client.query("select set_config('bootstrap.app_password', $1, false)", [
    pw,
  ]);
  await client.query(sql);
  console.log("bootstrap: role cooking_app and grants are in place");
} finally {
  await client.end();
}
