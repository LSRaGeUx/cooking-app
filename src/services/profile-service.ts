import { and, eq } from "drizzle-orm";
import { allergen, equipment, exclusion, profile } from "@/db/schema";
import type { AllergenRule, ExclusionRule } from "@/domain/allergens";
import { DomainError, validationError } from "@/domain/errors";
import {
  allergenInputSchema,
  equipmentInputSchema,
  exclusionInputSchema,
  profileInputSchema,
  type ProfileInput,
} from "@/domain/schemas";
import { inScope, type ServiceContext } from "./context";

/**
 * The enforced half of what we know about the cook. The screens for it land in
 * phase 3, but the rules that read it are enforced from phase 1, because
 * retrofitting the strict allergen block into an existing write path is exactly
 * the audit the project is trying to avoid.
 */

export interface EnforcementContext {
  readonly profile: typeof profile.$inferSelect;
  readonly allergens: AllergenRule[];
  readonly exclusions: ExclusionRule[];
  readonly equipmentKeys: string[];
}

/**
 * Reads the profile, creating the default row on first access. Every default
 * lives in the table definition, so a profile that has never been edited still
 * answers every question a planning rule asks.
 */
export async function getProfile(ctx: ServiceContext) {
  return inScope(ctx, async (tx) => {
    const existing = await tx
      .select()
      .from(profile)
      .where(eq(profile.userId, ctx.userId))
      .limit(1);
    if (existing[0]) return existing[0];

    const created = await tx
      .insert(profile)
      .values({ userId: ctx.userId })
      .onConflictDoNothing()
      .returning();
    if (created[0]) return created[0];

    // Lost a race with a concurrent first read. The row exists now.
    const reread = await tx
      .select()
      .from(profile)
      .where(eq(profile.userId, ctx.userId))
      .limit(1);
    if (!reread[0]) {
      throw new DomainError(
        "NOT_FOUND",
        "Le profil n'a pas pu être créé. Réessayez.",
      );
    }
    return reread[0];
  });
}

export async function updateProfile(
  ctx: ServiceContext,
  input: Partial<ProfileInput>,
) {
  const parsed = profileInputSchema.partial().parse(input);
  return inScope(ctx, async (tx) => {
    await getProfile({ ...ctx, tx });
    const updated = await tx
      .update(profile)
      .set({
        ...parsed,
        weeklyBudgetAmount:
          parsed.weeklyBudgetAmount === undefined
            ? undefined
            : parsed.weeklyBudgetAmount === null
              ? null
              : String(parsed.weeklyBudgetAmount),
        updatedAt: new Date(),
      })
      .where(eq(profile.userId, ctx.userId))
      .returning();
    return updated[0]!;
  });
}

export async function listAllergens(ctx: ServiceContext) {
  return inScope(ctx, (tx) =>
    tx.select().from(allergen).where(eq(allergen.userId, ctx.userId)),
  );
}

export async function createAllergen(
  ctx: ServiceContext,
  input: unknown,
) {
  const parsed = allergenInputSchema.parse(input);
  return inScope(ctx, async (tx) => {
    const rows = await tx
      .insert(allergen)
      .values({ ...parsed, userId: ctx.userId })
      .returning();
    return rows[0]!;
  });
}

export async function deleteAllergen(ctx: ServiceContext, allergenId: string) {
  return inScope(ctx, async (tx) => {
    await tx.delete(allergen).where(eq(allergen.id, allergenId));
  });
}

export async function listExclusions(ctx: ServiceContext) {
  return inScope(ctx, (tx) =>
    tx.select().from(exclusion).where(eq(exclusion.userId, ctx.userId)),
  );
}

export async function createExclusion(ctx: ServiceContext, input: unknown) {
  const parsed = exclusionInputSchema.parse(input);
  return inScope(ctx, async (tx) => {
    const rows = await tx
      .insert(exclusion)
      .values({ ...parsed, userId: ctx.userId })
      .onConflictDoNothing()
      .returning();
    if (!rows[0]) {
      throw validationError(
        `« ${parsed.name} » est déjà dans vos exclusions.`,
        { name: parsed.name },
      );
    }
    return rows[0];
  });
}

export async function deleteExclusion(ctx: ServiceContext, exclusionId: string) {
  return inScope(ctx, async (tx) => {
    await tx.delete(exclusion).where(eq(exclusion.id, exclusionId));
  });
}

export async function listEquipment(ctx: ServiceContext) {
  return inScope(ctx, (tx) =>
    tx.select().from(equipment).where(eq(equipment.userId, ctx.userId)),
  );
}

export async function createEquipment(ctx: ServiceContext, input: unknown) {
  const parsed = equipmentInputSchema.parse(input);
  return inScope(ctx, async (tx) => {
    const rows = await tx
      .insert(equipment)
      .values({ ...parsed, userId: ctx.userId })
      .onConflictDoNothing()
      .returning();
    if (rows[0]) return rows[0];

    // Already declared. Declaring it twice is not an error worth showing.
    const existing = await tx
      .select()
      .from(equipment)
      .where(and(eq(equipment.userId, ctx.userId), eq(equipment.key, parsed.key)))
      .limit(1);
    if (!existing[0]) {
      throw validationError("Cet équipement n'a pas pu être ajouté.", parsed);
    }
    return existing[0];
  });
}

export async function deleteEquipment(ctx: ServiceContext, equipmentId: string) {
  return inScope(ctx, async (tx) => {
    await tx.delete(equipment).where(eq(equipment.id, equipmentId));
  });
}

/**
 * Everything a planning write needs to validate itself, in one round trip.
 * Assembled here rather than in the plan service so there is one definition of
 * "the rules that apply to this user".
 */
export async function loadEnforcementContext(
  ctx: ServiceContext,
): Promise<EnforcementContext> {
  return inScope(ctx, async (tx) => {
    const scoped = { ...ctx, tx };
    // Sequential, not Promise.all: these all run on one transaction, and
    // node-postgres deprecates issuing a query on a client that is already
    // executing one. There is no parallelism to win on a single connection.
    const profileRow = await getProfile(scoped);
    const allergenRows = await listAllergens(scoped);
    const exclusionRows = await listExclusions(scoped);
    const equipmentRows = await listEquipment(scoped);

    return {
      profile: profileRow,
      allergens: allergenRows.map((row) => ({
        id: row.id,
        name: row.name,
        severity: row.severity as AllergenRule["severity"],
        matches: row.matches,
      })),
      exclusions: exclusionRows.map((row) => ({
        id: row.id,
        name: row.name,
        matches: row.matches,
      })),
      equipmentKeys: equipmentRows.map((row) => row.key),
    };
  });
}
