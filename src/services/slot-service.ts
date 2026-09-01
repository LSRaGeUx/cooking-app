import { and, asc, eq } from "drizzle-orm";
import { mealType, slotConfig } from "@/db/schema";
import { DomainError, validationError } from "@/domain/errors";
import {
  mealTypeInputSchema,
  slotConfigInputSchema,
  type SlotConfigInput,
} from "@/domain/schemas";
import { isIsoDay, ISO_DAYS, type IsoDay } from "@/domain/week";
import type { SlotDefinition, SlotState } from "@/domain/slots";
import { STARTER_MEAL_TYPES } from "@/domain/vocabulary";
import { inScope, type ServiceContext } from "./context";

/**
 * Slot configuration: which (day, meal) positions exist for this user, and what
 * each one expects.
 *
 * A (day, meal) pair with no row is `hidden`. That is the quiet default on
 * purpose: adding a meal type should not scatter seven new empty cells across
 * the week until the user says where they eat it.
 */

export async function listMealTypes(ctx: ServiceContext) {
  return inScope(ctx, (tx) =>
    tx
      .select()
      .from(mealType)
      .where(eq(mealType.userId, ctx.userId))
      .orderBy(asc(mealType.sortOrder), asc(mealType.label)),
  );
}

export async function createMealType(ctx: ServiceContext, input: unknown) {
  const parsed = mealTypeInputSchema.parse(input);
  return inScope(ctx, async (tx) => {
    const rows = await tx
      .insert(mealType)
      .values({ ...parsed, userId: ctx.userId })
      .onConflictDoNothing()
      .returning();
    if (!rows[0]) {
      throw validationError(
        `Un type de repas avec la clé « ${parsed.key} » existe déjà.`,
        { key: parsed.key },
      );
    }
    return rows[0];
  });
}

export async function renameMealType(
  ctx: ServiceContext,
  mealTypeId: string,
  label: string,
) {
  const parsed = mealTypeInputSchema.pick({ label: true }).parse({ label });
  return inScope(ctx, async (tx) => {
    const rows = await tx
      .update(mealType)
      .set({ label: parsed.label })
      .where(eq(mealType.id, mealTypeId))
      .returning();
    if (!rows[0]) {
      throw new DomainError("NOT_FOUND", "Ce type de repas n'existe pas.");
    }
    return rows[0];
  });
}

/**
 * Deleting a meal type cascades to its slot configuration but is refused by the
 * database while any plan entry still references it, which is the correct
 * outcome: historic plans stay readable.
 */
export async function deleteMealType(ctx: ServiceContext, mealTypeId: string) {
  return inScope(ctx, async (tx) => {
    await tx.delete(mealType).where(eq(mealType.id, mealTypeId));
  });
}

/**
 * The grid, joined and ordered, as the domain rules and the week screen want
 * it. Only configured rows appear; anything unconfigured is hidden.
 */
export async function loadSlotDefinitions(
  ctx: ServiceContext,
): Promise<SlotDefinition[]> {
  return inScope(ctx, async (tx) => {
    const rows = await tx
      .select({
        dayOfWeek: slotConfig.dayOfWeek,
        mealTypeId: slotConfig.mealTypeId,
        mealTypeKey: mealType.key,
        mealTypeLabel: mealType.label,
        mealTypeSortOrder: mealType.sortOrder,
        state: slotConfig.state,
        timeBudgetMin: slotConfig.timeBudgetMin,
        defaultServings: slotConfig.defaultServings,
      })
      .from(slotConfig)
      .innerJoin(mealType, eq(mealType.id, slotConfig.mealTypeId))
      .where(eq(slotConfig.userId, ctx.userId))
      .orderBy(
        asc(slotConfig.dayOfWeek),
        asc(mealType.sortOrder),
        asc(mealType.label),
      );

    return rows.flatMap((row) =>
      isIsoDay(row.dayOfWeek)
        ? [
            {
              dayOfWeek: row.dayOfWeek,
              mealTypeId: row.mealTypeId,
              mealTypeKey: row.mealTypeKey,
              mealTypeLabel: row.mealTypeLabel,
              state: row.state as SlotState,
              timeBudgetMin: row.timeBudgetMin,
              defaultServings: row.defaultServings,
            },
          ]
        : [],
    );
  });
}

/**
 * Upsert of one cell of the visual editor. Changing configuration never touches
 * an existing plan version: each version carries the grid it was made with.
 */
export async function setSlotConfig(ctx: ServiceContext, input: unknown) {
  const parsed = slotConfigInputSchema.parse(input);
  return inScope(ctx, async (tx) => {
    const owned = await tx
      .select({ id: mealType.id })
      .from(mealType)
      .where(
        and(eq(mealType.id, parsed.mealTypeId), eq(mealType.userId, ctx.userId)),
      )
      .limit(1);
    if (!owned[0]) {
      throw new DomainError(
        "NOT_FOUND",
        "Ce type de repas n'existe pas dans votre configuration.",
        { mealTypeId: parsed.mealTypeId },
      );
    }

    const rows = await tx
      .insert(slotConfig)
      .values({ ...parsed, userId: ctx.userId })
      .onConflictDoUpdate({
        target: [slotConfig.userId, slotConfig.dayOfWeek, slotConfig.mealTypeId],
        set: {
          state: parsed.state,
          timeBudgetMin: parsed.timeBudgetMin,
          defaultServings: parsed.defaultServings,
        },
      })
      .returning();
    return rows[0]!;
  });
}

export async function setSlotConfigs(
  ctx: ServiceContext,
  inputs: readonly unknown[],
) {
  return inScope(ctx, async (tx) => {
    const scoped = { ...ctx, tx };
    const saved: Array<Awaited<ReturnType<typeof setSlotConfig>>> = [];
    for (const input of inputs) {
      saved.push(await setSlotConfig(scoped, input));
    }
    return saved;
  });
}

/**
 * First-run setup: the three usual meals, and dinner planned every day. A new
 * user lands on a grid that already makes sense rather than on an empty screen
 * with a configuration errand.
 */
export async function seedStarterGrid(ctx: ServiceContext) {
  return inScope(ctx, async (tx) => {
    const scoped = { ...ctx, tx };
    const existing = await listMealTypes(scoped);
    if (existing.length > 0) return existing;

    const created = await tx
      .insert(mealType)
      .values(
        STARTER_MEAL_TYPES.map((type) => ({
          userId: ctx.userId,
          key: type.key,
          label: type.label,
          sortOrder: type.sortOrder,
        })),
      )
      .onConflictDoNothing()
      .returning();

    const dinner = created.find((type) => type.key === "dinner");
    if (dinner) {
      const rows: SlotConfigInput[] = ISO_DAYS.map((day: IsoDay) => ({
        dayOfWeek: day,
        mealTypeId: dinner.id,
        state: "planned" as const,
        timeBudgetMin: null,
        defaultServings: null,
      }));
      await tx
        .insert(slotConfig)
        .values(rows.map((row) => ({ ...row, userId: ctx.userId })))
        .onConflictDoNothing();
    }

    return created;
  });
}
