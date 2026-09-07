import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { mealType, slotConfig } from "@/db/schema";
import { firstRow } from "@/db/rows";
import { DomainError, validationError } from "@/domain/errors";
import {
  mealTypeInputSchema,
  slotConfigInputSchema,
  type SlotConfigInput,
} from "@/domain/schemas";
import { isIsoDay, ISO_DAYS, type IsoDay } from "@/domain/week";
import { dayName, type SlotDefinition, type SlotState } from "@/domain/slots";
import { STARTER_MEAL_TYPES } from "@/domain/vocabulary";
import { inScope, type ScopedContext, type ServiceContext } from "./context";

/**
 * Slot configuration: which (day, meal) positions exist for this user, and what
 * each one expects.
 *
 * A (day, meal) pair with no row is `hidden`. That is the quiet default on
 * purpose: adding a meal type should not scatter seven new empty cells across
 * the week until the user says where they eat it.
 */

export type SlotConfigView = typeof slotConfig.$inferSelect;

export async function listMealTypes(ctx: ServiceContext) {
  return inScope(ctx, ({ tx }) =>
    tx
      .select()
      .from(mealType)
      .where(eq(mealType.userId, ctx.userId))
      .orderBy(asc(mealType.sortOrder), asc(mealType.label)),
  );
}

export async function createMealType(ctx: ServiceContext, input: unknown) {
  const parsed = mealTypeInputSchema.parse(input);
  return inScope(ctx, async ({ tx }) => {
    const rows = await tx
      .insert(mealType)
      .values({ ...parsed, userId: ctx.userId })
      .onConflictDoNothing()
      .returning();
    const [created] = rows;
    if (!created) {
      throw validationError(
        `Un type de repas avec la clé « ${parsed.key} » existe déjà.`,
        { key: parsed.key },
      );
    }
    return created;
  });
}

export async function renameMealType(
  ctx: ServiceContext,
  mealTypeId: string,
  label: string,
) {
  const parsed = mealTypeInputSchema.pick({ label: true }).parse({ label });
  return inScope(ctx, async ({ tx }) => {
    const rows = await tx
      .update(mealType)
      .set({ label: parsed.label })
      .where(and(eq(mealType.id, mealTypeId), eq(mealType.userId, ctx.userId)))
      .returning();
    const [renamed] = rows;
    if (!renamed) {
      throw new DomainError("NOT_FOUND", "Ce type de repas n'existe pas.", {
        mealTypeId,
      });
    }
    return renamed;
  });
}

/**
 * Deleting a meal type cascades to its slot configuration, and is refused while
 * any plan entry still references it, which is the correct outcome: historic
 * plans stay readable.
 *
 * The refusal used to come from the foreign key's `on delete restrict`, so the
 * caller got a raw `23503` naming a constraint. The pre-check does the same job
 * and can say which weeks are in the way, which is the difference between an
 * error the user can act on and one they can only report.
 */
export async function deleteMealType(ctx: ServiceContext, mealTypeId: string) {
  return inScope(ctx, async ({ tx }) => {
    const referencing = await tx.execute<{
      iso_year: number;
      iso_week: number;
      entries: number;
    }>(sql`
      select p.iso_year, p.iso_week, count(*)::int as entries
      from plan_entry pe
      join plan_version pv on pv.id = pe.plan_version_id
      join plan p on p.id = pv.plan_id
      where pe.user_id = ${ctx.userId}
        and pe.meal_type_id = ${mealTypeId}
      group by p.iso_year, p.iso_week
      order by p.iso_year desc, p.iso_week desc
    `);

    if (referencing.rows.length > 0) {
      const weeks = referencing.rows.map(
        (row) => `${row.iso_year}-W${String(row.iso_week).padStart(2, "0")}`,
      );
      throw new DomainError(
        "VALIDATION",
        `Ce type de repas est utilisé par des repas déjà planifiés, dans ${weeks.length === 1 ? "la semaine" : "les semaines"} ${weeks.join(", ")}. Les plans passés doivent rester lisibles, donc la suppression est refusée. Masquez le créneau dans la grille pour ne plus vous le voir proposer, ou videz d'abord ces repas.`,
        { mealTypeId, weeks, weekCount: weeks.length },
      );
    }

    const rows = await tx
      .delete(mealType)
      .where(and(eq(mealType.id, mealTypeId), eq(mealType.userId, ctx.userId)))
      .returning({ id: mealType.id });
    if (!rows[0]) {
      throw new DomainError("NOT_FOUND", "Ce type de repas n'existe pas.", {
        mealTypeId,
      });
    }
  });
}

/**
 * The grid, joined and ordered, as the domain rules and the week screen want
 * it. Only configured rows appear; anything unconfigured is hidden.
 */
export async function loadSlotDefinitions(
  ctx: ServiceContext,
): Promise<SlotDefinition[]> {
  return inScope(ctx, async ({ tx }) => {
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
              // `text` plus a check constraint, so Drizzle types it `string`.
              // Narrowed at this one boundary rather than by every reader.
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
export async function setSlotConfig(
  ctx: ServiceContext,
  input: unknown,
): Promise<SlotConfigView> {
  const parsed = slotConfigInputSchema.parse(input);
  return inScope(ctx, async (scoped) => {
    await requireOwnedMealTypes(scoped, [parsed.mealTypeId]);
    const saved = await scoped.tx
      .insert(slotConfig)
      .values({ ...parsed, userId: ctx.userId })
      .onConflictDoUpdate({
        target: [
          slotConfig.userId,
          slotConfig.dayOfWeek,
          slotConfig.mealTypeId,
        ],
        set: {
          state: parsed.state,
          timeBudgetMin: parsed.timeBudgetMin,
          defaultServings: parsed.defaultServings,
        },
      })
      .returning();
    return firstRow(saved, "slot config upsert");
  });
}

/**
 * `setSlotConfigs` is gone. It saved the grid cell by cell, an ownership select
 * plus an upsert each, which was 2N queries for one gesture, and the fix would
 * have been one ownership check plus a multi-row upsert. It had exactly one
 * caller, a server action the UI removed because nothing rendered it, and no
 * MCP tool touches slot configuration at all. A batched version of a function
 * nothing calls is not worth carrying: `setSlotConfig` is the per-cell door
 * the editor uses, and a batch door can come back with the caller that wants
 * it.
 */

/**
 * Patches only the time budget of one slot.
 *
 * It exists because the budget suggestion used to be applied by rebuilding the
 * whole slot configuration from a form, which meant accepting "make Tuesday 25
 * minutes" also wrote `defaultServings: null` over whatever the user had set.
 * A patch that names one column cannot do that.
 */
export async function patchSlotTimeBudget(
  ctx: ServiceContext,
  ref: { dayOfWeek: number; mealTypeId: string },
  timeBudgetMin: number,
): Promise<SlotConfigView> {
  const parsed = slotConfigInputSchema
    .pick({ dayOfWeek: true, mealTypeId: true, timeBudgetMin: true })
    .parse({ ...ref, timeBudgetMin });

  return inScope(ctx, async ({ tx }) => {
    const rows = await tx
      .update(slotConfig)
      .set({ timeBudgetMin: parsed.timeBudgetMin })
      .where(
        and(
          eq(slotConfig.userId, ctx.userId),
          eq(slotConfig.dayOfWeek, parsed.dayOfWeek),
          eq(slotConfig.mealTypeId, parsed.mealTypeId),
        ),
      )
      .returning();
    const [updated] = rows;
    if (!updated) {
      throw new DomainError(
        "NOT_FOUND",
        `Aucun créneau configuré ${dayName(parsed.dayOfWeek)} pour ce type de repas. Configurez-le d'abord dans la grille : un budget de temps sur un créneau qui n'existe pas ne contraindrait rien.`,
        { dayOfWeek: parsed.dayOfWeek, mealTypeId: parsed.mealTypeId },
      );
    }
    return updated;
  });
}

/**
 * First-run setup: the three usual meals, and dinner planned every day. A new
 * user lands on a grid that already makes sense rather than on an empty screen
 * with a configuration errand.
 */
export async function seedStarterGrid(ctx: ServiceContext) {
  return inScope(ctx, async (scoped) => {
    const { tx } = scoped;
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

/**
 * One query proving every meal type in a save belongs to this user, naming the
 * ones that do not. The foreign key would refuse an unowned id anyway, but a
 * foreign key check runs as the table owner and bypasses row-level security, so
 * it answers "does this uuid exist anywhere" rather than "is it yours": that is
 * an existence oracle, and the error it produces names a constraint instead of
 * a meal type.
 */
async function requireOwnedMealTypes(
  ctx: ScopedContext,
  mealTypeIds: readonly string[],
): Promise<void> {
  if (mealTypeIds.length === 0) return;

  const owned = await ctx.tx
    .select({ id: mealType.id })
    .from(mealType)
    .where(
      and(
        eq(mealType.userId, ctx.userId),
        inArray(mealType.id, [...mealTypeIds]),
      ),
    );

  const found = new Set(owned.map((row) => row.id));
  const missing = mealTypeIds.filter((id) => !found.has(id));
  if (missing.length === 0) return;

  throw new DomainError(
    "NOT_FOUND",
    `Ce type de repas n'existe pas dans votre configuration : ${missing.join(", ")}. Les identifiants valides sont ceux de la ressource des créneaux.`,
    { mealTypeIds: missing },
  );
}
