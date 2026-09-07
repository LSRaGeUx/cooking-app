import { inScope, type ServiceContext } from "./context";
import { seedStarterIngredients } from "./ingredient-service";
import { getProfile } from "./profile-service";
import { seedStarterGrid } from "./slot-service";

/**
 * First-run setup, idempotent, run on the first authenticated request rather
 * than as a hook on sign-up. Better Auth owns the user table and its lifecycle,
 * so hanging domain seeding off its callbacks would couple our schema to its
 * internals for no gain: an idempotent ensure is cheap and cannot be skipped by
 * a user created any other way (a migration, a test, a future import).
 */

/**
 * Users this process has already set up.
 *
 * The ensure is idempotent but not free: three queries, on every authenticated
 * request, for a row that was created on the user's first ever visit and can
 * never go back to needing creation. Remembering the answer for the life of the
 * process turns that into three queries per user per deploy.
 *
 * A `Set` rather than a cache with eviction, deliberately. The entry is a user
 * id and a boolean, the population is the users of one self-hosted instance,
 * and the wrong answer in either direction is not available: setup cannot
 * un-happen, and a restart forgets everything and re-ensures. Nothing here is
 * shared between processes, which is correct, because the check exists to skip
 * work rather than to hold a lock.
 */
const setUpUserIds = new Set<string>();

export async function ensureUserSetup(ctx: ServiceContext): Promise<void> {
  if (setUpUserIds.has(ctx.userId)) return;

  await inScope(ctx, async (scoped) => {
    await getProfile(scoped);
    await seedStarterGrid(scoped);
    await seedStarterIngredients(scoped);
  });

  // Recorded after the transaction, so a failed setup is retried on the next
  // request rather than remembered as done.
  setUpUserIds.add(ctx.userId);
}

/**
 * Forgets the memo. Called by `deleteAccount`, which is the one thing that can
 * make a set-up user need setting up again: the row it seeded is gone, and
 * without this the process would keep claiming the work was already done.
 */
export function forgetUserSetup(userId: string): void {
  setUpUserIds.delete(userId);
}
