/**
 * The suite runs with an open allowlist, whatever the developer's .env holds.
 *
 * `ALLOWED_EMAILS` is a real value on a real machine, and test users are
 * synthetic addresses that will never be on it. Inheriting it makes every guard
 * test fail with ACCESS_REVOKED here and pass in CI, which is exactly the
 * environment-dependence the test database exists to remove. A test that cares
 * about the allowlist sets it itself and puts it back.
 *
 * Empty is open outside production, and NODE_ENV is "test" under Vitest.
 */
process.env.ALLOWED_EMAILS = "";
