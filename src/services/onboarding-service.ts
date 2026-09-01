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
export async function ensureUserSetup(ctx: ServiceContext): Promise<void> {
  await inScope(ctx, async (tx) => {
    const scoped = { ...ctx, tx };
    await getProfile(scoped);
    await seedStarterGrid(scoped);
    await seedStarterIngredients(scoped);
  });
}
