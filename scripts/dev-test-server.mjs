// Boots the development server against the test database, which is what
// `npm run verify:oauth` should be pointed at.
//
// verify:oauth drives a real HTTP server rather than a module, so it writes
// wherever that server writes. Isolating it is therefore a matter of which
// server you start, not of changing the script: run this in one terminal and
// `npm run verify:oauth` in another.
//
// Two overrides beyond the database. The allowlist is emptied, because the
// script signs in as VERIFY_EMAIL and an instance allowlist would refuse it, and
// password sign-in is forced on, because nothing can drive a Google consent
// screen from a script.
import "dotenv/config";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { testUrls } from "./lib/db.mjs";

const { owner, app } = testUrls();

const env = {
  ...process.env,
  DATABASE_URL: owner,
  APP_DATABASE_URL: app,
  ALLOWED_EMAILS: "",
  AUTH_PASSWORD_LOGIN: "true",
};

console.log("dev:test: serving on the test database, allowlist open, password sign-in on");

const next = fileURLToPath(new URL("../node_modules/.bin/next", import.meta.url));
const child = spawn(next, ["dev"], { stdio: "inherit", env });

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code) => process.exit(code ?? 0));
