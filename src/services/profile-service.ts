import { and, eq } from "drizzle-orm";
import { allergen, equipment, exclusion, profile } from "@/db/schema";
import { firstRow } from "@/db/rows";
import type { AllergenRule, ExclusionRule } from "@/domain/allergens";
import {
  DomainError,
  validationError,
  type DomainErrorDetails,
} from "@/domain/errors";
import {
  allergenInputSchema,
  equipmentInputSchema,
  exclusionInputSchema,
  profileInputSchema,
  type ProfileInput,
} from "@/domain/schemas";
import type { AllergenSeverityValue } from "@/domain/vocabulary";
import { inScope, type ServiceContext } from "./context";

/**
 * The enforced half of what we know about the cook. The screens for it land in
 * phase 3, but the rules that read it are enforced from phase 1, because
 * retrofitting the strict allergen block into an existing write path is exactly
 * the audit the project is trying to avoid.
 *
 * Three writes here are refused to an agent, and the reason is the same for all
 * three: they are the settings that decide what an agent is allowed to do, and
 * what it is absolutely blocked from doing. An agent that could set
 * `agentAuthority` to `direct` would be granting itself the right to write the
 * plan without review, and one that could delete a strict allergen would be
 * removing the only hard block in the system. Neither had an MCP tool, which is
 * not the same as being impossible: rule 3 says a rule enforced only by the
 * absence of a tool is not enforced, and the tool list is the easiest thing in
 * the codebase to change by accident.
 */

export interface EnforcementContext {
  readonly profile: typeof profile.$inferSelect;
  readonly allergens: AllergenRule[];
  readonly exclusions: ExclusionRule[];
  readonly equipmentKeys: string[];
}

/** The message every one of the guards below shares. */
function refuseAgent(what: string, details: DomainErrorDetails): never {
  throw new DomainError(
    "FORBIDDEN",
    `${what} Ce sont les réglages qui décident de ce qu'un agent peut faire, et de ce qui lui est absolument interdit : ils n'appartiennent qu'à la personne concernée. Proposez le changement dans la conversation et laissez-la l'appliquer depuis son profil.`,
    details,
  );
}

/**
 * Reads the profile, creating the default row on first access. Every default
 * lives in the table definition, so a profile that has never been edited still
 * answers every question a planning rule asks.
 */
export async function getProfile(ctx: ServiceContext) {
  return inScope(ctx, async ({ tx }) => {
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

  // The escalation this guard exists for: `agentAuthority: "direct"` is the
  // setting that turns a proposal into an immediate write, and an agent that
  // could set it would be granting itself the permission the whole review
  // surface exists to withhold.
  if (parsed.agentAuthority !== undefined && ctx.actor !== "user") {
    refuseAgent("Un agent ne peut pas modifier son propre niveau d'autorité.", {
      field: "agentAuthority",
      requested: parsed.agentAuthority,
    });
  }

  // The tolerance decides how far past a slot's time budget a write is merely
  // warned about rather than refused, so raising it weakens a block in exactly
  // the same way.
  if (parsed.timeBudgetToleranceMin !== undefined && ctx.actor !== "user") {
    refuseAgent(
      "Un agent ne peut pas modifier la tolérance de dépassement du budget de temps.",
      {
        field: "timeBudgetToleranceMin",
        requested: parsed.timeBudgetToleranceMin,
      },
    );
  }

  return inScope(ctx, async (scoped) => {
    await getProfile(scoped);
    const updated = await scoped.tx
      .update(profile)
      .set({
        ...parsed,
        weeklyBudgetAmount:
          parsed.weeklyBudgetAmount === undefined
            ? undefined
            : parsed.weeklyBudgetAmount === null
              ? null
              : String(parsed.weeklyBudgetAmount),
        // No `updatedAt` by hand: `updatedAt()` in src/db/schema/_shared.ts
        // carries `$onUpdate`, so Drizzle writes it into every update it builds.
      })
      .where(eq(profile.userId, ctx.userId))
      .returning();
    return firstRow(updated, "profile update");
  });
}

export async function listAllergens(ctx: ServiceContext) {
  return inScope(ctx, ({ tx }) =>
    tx.select().from(allergen).where(eq(allergen.userId, ctx.userId)),
  );
}

/**
 * Adding an allergen needs no cache invalidation, because there is no longer a
 * cache to invalidate: `recipe.allergen_ids` used to be refreshed only when a
 * recipe was written, so adding or removing an allergen here left every recipe
 * in the library carrying a list computed against the old rules. The listing
 * then showed a recipe as clean while the assignment path, which re-runs the
 * matcher against live data, blocked it. The recipe service now derives the
 * hits at read time. See the note at the head of that file.
 */
export async function createAllergen(ctx: ServiceContext, input: unknown) {
  const parsed = allergenInputSchema.parse(input);
  return inScope(ctx, async ({ tx }) => {
    const rows = await tx
      .insert(allergen)
      .values({ ...parsed, userId: ctx.userId })
      .onConflictDoNothing()
      .returning();
    const [created] = rows;
    if (!created) {
      throw validationError(
        `« ${parsed.name} » est déjà dans vos allergènes.`,
        {
          name: parsed.name,
        },
      );
    }
    return created;
  });
}

/**
 * Deleting an allergen, which only a person may do when it is strict.
 *
 * A strict allergen is the only absolute block in the system, and removing one
 * removes a health protection. There was no actor check at all, so the only
 * thing keeping an agent away from it was the absence of a tool.
 */
export async function deleteAllergen(ctx: ServiceContext, allergenId: string) {
  return inScope(ctx, async ({ tx }) => {
    const existing = await tx
      .select()
      .from(allergen)
      .where(and(eq(allergen.id, allergenId), eq(allergen.userId, ctx.userId)))
      .limit(1);
    const [found] = existing;
    if (!found) {
      throw new DomainError("NOT_FOUND", "Cet allergène n'existe pas.", {
        allergenId,
      });
    }

    if (ctx.actor !== "user") {
      refuseAgent(
        `Un agent ne peut pas supprimer un allergène. « ${found.name} » est ${found.severity === "strict" ? "un blocage absolu" : "une préférence forte"} enregistré par la personne concernée.`,
        { allergenId, name: found.name, severity: found.severity },
      );
    }

    await tx
      .delete(allergen)
      .where(and(eq(allergen.id, allergenId), eq(allergen.userId, ctx.userId)));
  });
}

export async function listExclusions(ctx: ServiceContext) {
  return inScope(ctx, ({ tx }) =>
    tx.select().from(exclusion).where(eq(exclusion.userId, ctx.userId)),
  );
}

export async function createExclusion(ctx: ServiceContext, input: unknown) {
  const parsed = exclusionInputSchema.parse(input);
  return inScope(ctx, async ({ tx }) => {
    const rows = await tx
      .insert(exclusion)
      .values({ ...parsed, userId: ctx.userId })
      .onConflictDoNothing()
      .returning();
    const [created] = rows;
    if (!created) {
      throw validationError(
        `« ${parsed.name} » est déjà dans vos exclusions.`,
        { name: parsed.name },
      );
    }
    return created;
  });
}

/**
 * An exclusion only ever produces a warning, so deleting one weakens nothing
 * absolute. It is still the person's own declaration about what they will eat,
 * which is not an agent's to withdraw.
 */
export async function deleteExclusion(
  ctx: ServiceContext,
  exclusionId: string,
) {
  requireUserActor(ctx, "Un agent ne peut pas supprimer une exclusion.", {
    exclusionId,
  });

  return inScope(ctx, async ({ tx }) => {
    const rows = await tx
      .delete(exclusion)
      .where(
        and(eq(exclusion.id, exclusionId), eq(exclusion.userId, ctx.userId)),
      )
      .returning({ id: exclusion.id });
    if (!rows[0]) {
      throw new DomainError("NOT_FOUND", "Cette exclusion n'existe pas.", {
        exclusionId,
      });
    }
  });
}

export async function listEquipment(ctx: ServiceContext) {
  return inScope(ctx, ({ tx }) =>
    tx.select().from(equipment).where(eq(equipment.userId, ctx.userId)),
  );
}

export async function createEquipment(ctx: ServiceContext, input: unknown) {
  const parsed = equipmentInputSchema.parse(input);
  return inScope(ctx, async ({ tx }) => {
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
      .where(
        and(eq(equipment.userId, ctx.userId), eq(equipment.key, parsed.key)),
      )
      .limit(1);
    const [found] = existing;
    if (!found) {
      throw validationError("Cet équipement n'a pas pu être ajouté.", parsed);
    }
    return found;
  });
}

/**
 * Declared equipment drives an `EQUIPMENT_MISSING` warning, so removing a line
 * makes recipes look unusable rather than unsafe. Still the person's own
 * statement about their kitchen.
 */
export async function deleteEquipment(
  ctx: ServiceContext,
  equipmentId: string,
) {
  requireUserActor(
    ctx,
    "Un agent ne peut pas supprimer un équipement déclaré.",
    { equipmentId },
  );

  return inScope(ctx, async ({ tx }) => {
    const rows = await tx
      .delete(equipment)
      .where(
        and(eq(equipment.id, equipmentId), eq(equipment.userId, ctx.userId)),
      )
      .returning({ id: equipment.id });
    if (!rows[0]) {
      throw new DomainError("NOT_FOUND", "Cet équipement n'existe pas.", {
        equipmentId,
      });
    }
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
  return inScope(ctx, async (scoped) => {
    // Sequential, not Promise.all: these all run on one transaction, and
    // node-postgres deprecates issuing a query on a client that is already
    // executing one. There is no parallelism to win on a single connection.
    const profileRow = await getProfile(scoped);
    const allergenRows = await listAllergens(scoped);
    const exclusionRows = await listExclusions(scoped);
    const equipmentRows = await listEquipment(scoped);

    return {
      profile: profileRow,
      allergens: allergenRows.map(toAllergenRule),
      exclusions: exclusionRows.map((row) => ({
        id: row.id,
        name: row.name,
        matches: row.matches,
      })),
      equipmentKeys: equipmentRows.map((row) => row.key),
    };
  });
}

/**
 * One allergen row as the matcher wants it. The severity narrowing lives here,
 * at the single boundary that turns a row into a rule, rather than being cast
 * again in the recipe service.
 */
export function toAllergenRule(
  row: typeof allergen.$inferSelect,
): AllergenRule {
  return {
    id: row.id,
    name: row.name,
    severity: row.severity as AllergenSeverityValue,
    matches: row.matches,
  };
}

function requireUserActor(
  ctx: ServiceContext,
  what: string,
  details: DomainErrorDetails,
): void {
  if (ctx.actor === "user") return;
  refuseAgent(what, details);
}
