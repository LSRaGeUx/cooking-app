// Where `npm run dev:test` serves, and therefore where `npm run verify:oauth`
// looks. One definition, because the two run in different terminals and a
// disagreement between them means the verification silently drives the
// development server instead.
//
// Loopback only, and a port of its own rather than 3000: dev:test opens an
// unauthenticated sign-up door, and 3000 is where `npm run dev` already is.
export const DEV_TEST_HOST = "127.0.0.1";

const DEFAULT_PORT = 3100;

/**
 * Validated, not merely coerced. `Number("three thousand")` is NaN, and NaN
 * used to travel all the way to `next dev --port NaN`, where it becomes a
 * default port and the verification quietly drives whatever answers on it. The
 * same for a port outside the range, which fails inside Node with an error that
 * names neither this variable nor this file.
 */
export function devTestPort(env = process.env) {
  const raw = env.DEV_TEST_PORT;
  if (!raw) return DEFAULT_PORT;

  const port = Number(raw);
  // 1024 rather than 1: dev:test runs as a developer, and a privileged port
  // would fail to bind for a reason that has nothing to do with this project.
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(
      `DEV_TEST_PORT must be a whole number between 1024 and 65535, not ` +
        `"${raw}". Leave it unset to use ${DEFAULT_PORT}.`,
    );
  }
  return port;
}

export function devTestOrigin(env = process.env) {
  return `http://${DEV_TEST_HOST}:${devTestPort(env)}`;
}
