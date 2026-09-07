import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Walking the repository, for the tests that read files rather than call code.
 *
 * Deliberately its own module and not part of `tests/helpers/index.ts`, which
 * imports `@/db/client` and therefore opens a connection pool the moment it is
 * touched. `tests/messages.test.ts` and `tests/deploy.test.ts` read text off
 * disk and need no database, and a shared helper that quietly made them wait on
 * Postgres would be a worse trade than one duplicated `readdirSync`.
 */

/** The repository root, from wherever a test file sits under `tests/`. */
export const repoRoot = join(import.meta.dirname, "..", "..");

/**
 * Every file under `dir` whose name ends in one of `extensions`, recursively.
 *
 * Both callers used to have their own copy, and one of them read
 * `messages/fr.json` relative to `process.cwd()` instead, which is the working
 * directory rather than the repository: correct for `npm test` from the root and
 * wrong for `vitest --root`, for an editor's test runner, and for anything that
 * runs the suite from a subdirectory. Everything here is anchored on
 * `import.meta.dirname`, which is the file's own location and cannot drift.
 */
export function filesUnder(
  dir: string,
  extensions: readonly string[] = [".ts", ".tsx"],
): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return filesUnder(path, extensions);
    return extensions.some((extension) => entry.endsWith(extension))
      ? [path]
      : [];
  });
}

/** `filesUnder`, anchored on the repository root. */
export function repoFiles(
  relativeDir: string,
  extensions?: readonly string[],
): string[] {
  return filesUnder(join(repoRoot, relativeDir), extensions);
}
