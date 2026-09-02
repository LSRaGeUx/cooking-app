/** Loopback, always: dev:test opens an unauthenticated sign-up door. */
export const DEV_TEST_HOST: string;

/** The port `npm run dev:test` serves on. DEV_TEST_PORT overrides it. */
export function devTestPort(env?: NodeJS.ProcessEnv): number;

/** The origin `npm run dev:test` serves on, and verify:oauth drives. */
export function devTestOrigin(env?: NodeJS.ProcessEnv): string;
