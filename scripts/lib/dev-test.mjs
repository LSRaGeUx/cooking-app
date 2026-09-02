// Where `npm run dev:test` serves, and therefore where `npm run verify:oauth`
// looks. One definition, because the two run in different terminals and a
// disagreement between them means the verification silently drives the
// development server instead.
//
// Loopback only, and a port of its own rather than 3000: dev:test opens an
// unauthenticated sign-up door, and 3000 is where `npm run dev` already is.
export const DEV_TEST_HOST = "127.0.0.1";

export function devTestPort(env = process.env) {
  return Number(env.DEV_TEST_PORT || 3100);
}

export function devTestOrigin(env = process.env) {
  return `http://${DEV_TEST_HOST}:${devTestPort(env)}`;
}
