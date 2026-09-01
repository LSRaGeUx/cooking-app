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
// screen from a script. Between them that is an unauthenticated sign-up door,
// so the server is bound to loopback and nowhere else: `next dev` otherwise
// listens on 0.0.0.0 and publishes it to everyone on the network.
//
// It also takes a port of its own rather than 3000. `next dev` silently
// increments past a port already in use, and the increment lands in this
// terminal while verify:oauth, reading its own default, drives whatever answers
// on 3000: the development server, writing test fixtures into real data.
import "dotenv/config";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertTestUrls, testUrls } from "./lib/db.mjs";
import { DEV_TEST_HOST, devTestOrigin, devTestPort } from "./lib/dev-test.mjs";

const PORT = devTestPort();
const ORIGIN = devTestOrigin();

const urls = testUrls();
let name;
try {
  name = assertTestUrls(urls);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const env = {
  ...process.env,
  DATABASE_URL: urls.owner,
  APP_DATABASE_URL: urls.app,
  ALLOWED_EMAILS: "",
  AUTH_PASSWORD_LOGIN: "true",
  // The issuer and the audience both have to name the port this actually serves
  // on, or every token is refused for the wrong reason.
  BETTER_AUTH_URL: ORIGIN,
  MCP_RESOURCE: `${ORIGIN}/api/mcp`,
  // A build directory of its own, so running this alongside `npm run dev` does
  // not have the two servers overwriting each other's compiled output.
  NEXT_DIST_DIR: ".next-test",
};

console.log(
  `dev:test: ${ORIGIN}, database ${name}, allowlist open, password sign-in on`,
);

const next = fileURLToPath(new URL("../node_modules/.bin/next", import.meta.url));
const child = spawn(
  // An explicit --port is also what stops the silent increment: next dev only
  // retries the next port when it fell back to its own default.
  next,
  ["dev", "--hostname", DEV_TEST_HOST, "--port", String(PORT)],
  { stdio: "inherit", env },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}
// A child killed by a signal reports a null code, which must not read as success.
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
