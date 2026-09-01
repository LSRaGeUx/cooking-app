import { and, asc, desc, eq } from "drizzle-orm";
import { plan, planEntry, planVersion } from "@/db/schema";
import {
  assertNoStrictAllergen,
  collectIngredientWarnings,
} from "@/domain/allergens";
import { DomainError, type DomainWarning } from "@/domain/errors";
import {
  isoWeekSchema,
  planEntryInputSchema,
  slotRefSchema,
  type SlotSnapshot,
} from "@/domain/schemas";
import {
  activeTimeOf,
  checkTimeBudget,
  describeSlot,
  resolvePlannableSlot,
  type SlotDefinition,
} from "@/domain/slots";
import type { IsoWeek } from "@/domain/week";
import { inScope, type ServiceContext } from "./context";
import { loadEnforcementContext, type EnforcementContext } from "./profile-service";
import { loadRecipesForValidation, type RecipeForValidation } from "./recipe-service";
import { loadSlotDefinitions } from "./slot-service";

/**
 * Planning. The load-bearing rule of the whole codebase lives here: a plan
 * version is immutable, so every edit writes a new version and supersedes the
 * old one. That is what makes an agent proposal reviewable, a bad week
 * revertible, and the history of a plan honest.
 *
 * Consequence worth stating: dragging one entry produces a version. The
 * alternative, mutating the active version for "small" edits, would mean the
 * revert path only works for some changes, which is worse than a long history.
 *
 * Every write revalidates the entire resulting week rather than only the entry
 * that changed. A new version must be valid as a whole, so an allergen added
 * after a week was planned blocks the next edit to that week instead of
 * silently surviving in it.
 */

export interface PlanEntryView {
  readonly id: string;
  readonly dayOfWeek: number;
  readonly mealTypeId: string;
  readonly recipeId: string | null;
  readonly recipeTitleSnapshot: string;
  readonly recipeRevisionSnapshot: number | null;
  readonly servings: number;
  readonly note: string | null;
  readonly rationale: string | null;
  readonly position: number;
}

export interface PlanVersionView {
  readonly id: string;
  readonly versionNumber: number;
  readonly state: string;
  readonly createdBy: string;
  readonly summary: string | null;
  readonly createdAt: Date;
  readonly activatedAt: Date | null;
}

export interface WeekView {
  readonly isoWeek: IsoWeek;
  readonly planId: string | null;
  readonly activeVersion: PlanVersionView | null;
  readonly pendingVersion: PlanVersionView | null;
  readonly slots: SlotDefinition[];
  readonly entries: PlanEntryView[];
  /** Entries whose slot is no longer planned. Kept, never silently dropped. */
  readonly orphanedEntries: PlanEntryView[];
}

export interface WriteResult {
  readonly version: PlanVersionView;
  readonly entries: PlanEntryView[];
  readonly warnings: DomainWarning[];
}

/** The mutable working copy a mutation operates on. */
interface EntryDraft {
  /** The row this draft came from in the previous version, when it had one. */
  sourceEntryId?: string;
  dayOfWeek: number;
  mealTypeId: string;
  recipeId: string | null;
  recipeTitleSnapshot: string;
  recipeRevisionSnapshot: number | null;
  servings: number;
  note: string | null;
  rationale: string | null;
  rationaleRefs: unknown;
  position: number;
}

export async function getWeekView(
  ctx: ServiceContext,
  week: unknown,
): Promise<WeekView> {
  const isoWeek = isoWeekSchema.parse(week);

  return inScope(ctx, async (tx) => {
    const scoped = { ...ctx, tx };
    const slots = await loadSlotDefinitions(scoped);

    const planRow = await findPlan(scoped, isoWeek);
    if (!planRow) {
      // No implicit plan creation: an unvisited week is plannable, not planned.
      return {
        isoWeek,
        planId: null,
        activeVersion: null,
        pendingVersion: null,
        slots,
        entries: [],
        orphanedEntries: [],
      };
    }

    const versions = await tx
      .select()
      .from(planVersion)
      .where(eq(planVersion.planId, planRow.id))
      .orderBy(desc(planVersion.versionNumber));

    const active = versions.find((version) => version.state === "active");
    const pending = versions.find((version) => version.state === "pending");
    const entries = active ? await loadEntries(scoped, active.id) : [];

    const planned = new Set(
      slots
        .filter((slot) => slot.state === "planned")
        .map((slot) => slotKey(slot.dayOfWeek, slot.mealTypeId)),
    );

    return {
      isoWeek,
      planId: planRow.id,
      activeVersion: active ? toVersionView(active) : null,
      pendingVersion: pending ? toVersionView(pending) : null,
      slots,
      entries: entries.filter((entry) =>
        planned.has(slotKey(entry.dayOfWeek, entry.mealTypeId)),
      ),
      orphanedEntries: entries.filter(
        (entry) => !planned.has(slotKey(entry.dayOfWeek, entry.mealTypeId)),
      ),
    };
  });
}

export async function listVersions(
  ctx: ServiceContext,
  week: unknown,
): Promise<PlanVersionView[]> {
  const isoWeek = isoWeekSchema.parse(week);
  return inScope(ctx, async (tx) => {
    const scoped = { ...ctx, tx };
    const planRow = await findPlan(scoped, isoWeek);
    if (!planRow) return [];
    const rows = await tx
      .select()
      .from(planVersion)
      .where(eq(planVersion.planId, planRow.id))
      .orderBy(desc(planVersion.versionNumber));
    return rows.map(toVersionView);
  });
}

export async function getVersionEntries(
  ctx: ServiceContext,
  planVersionId: string,
): Promise<PlanEntryView[]> {
  return inScope(ctx, (tx) => loadEntries({ ...ctx, tx }, planVersionId));
}

export async function assignRecipe(
  ctx: ServiceContext,
  week: unknown,
  input: unknown,
): Promise<WriteResult> {
  const entry = planEntryInputSchema.parse(input);

  return mutateWeek(ctx, week, async (drafts, helpers) => {
    const slot = resolvePlannableSlot(helpers.slots, entry);
    const recipe = await helpers.requireRecipe(entry.recipeId);

    const servings =
      entry.servings ??
      slot.defaultServings ??
      helpers.enforcement.profile.defaultServings;

    const next = drafts.filter(
      (draft) =>
        !(
          draft.dayOfWeek === entry.dayOfWeek &&
          draft.mealTypeId === entry.mealTypeId &&
          draft.position === entry.position
        ),
    );

    next.push({
      dayOfWeek: entry.dayOfWeek,
      mealTypeId: entry.mealTypeId,
      recipeId: recipe.recipe.id,
      recipeTitleSnapshot: recipe.recipe.title,
      recipeRevisionSnapshot: recipe.recipe.revision,
      servings,
      note: entry.note,
      rationale: null,
      rationaleRefs: null,
      position: entry.position,
    });

    return next;
  });
}

export async function clearEntry(
  ctx: ServiceContext,
  week: unknown,
  entryId: string,
): Promise<WriteResult> {
  return mutateWeek(ctx, week, async (drafts, helpers) => {
    const target = helpers.requireDraft(drafts, entryId);
    return drafts.filter((draft) => draft !== target);
  });
}

export async function clearSlot(
  ctx: ServiceContext,
  week: unknown,
  slotRef: unknown,
): Promise<WriteResult> {
  const ref = slotRefSchema.parse(slotRef);
  return mutateWeek(ctx, week, async (drafts) =>
    drafts.filter(
      (draft) =>
        !(
          draft.dayOfWeek === ref.dayOfWeek && draft.mealTypeId === ref.mealTypeId
        ),
    ),
  );
}

/**
 * Drag between slots. A drop on an occupied slot swaps the two entries, which
 * is the behaviour a grid implies and the only one that is its own undo.
 */
export async function moveEntry(
  ctx: ServiceContext,
  week: unknown,
  entryId: string,
  target: unknown,
): Promise<WriteResult> {
  const ref = slotRefSchema.parse(target);

  return mutateWeek(ctx, week, async (drafts, helpers) => {
    const moving = helpers.requireDraft(drafts, entryId);
    resolvePlannableSlot(helpers.slots, ref);

    const occupant = drafts.find(
      (draft) =>
        draft !== moving &&
        draft.dayOfWeek === ref.dayOfWeek &&
        draft.mealTypeId === ref.mealTypeId &&
        draft.position === moving.position,
    );

    const from = { dayOfWeek: moving.dayOfWeek, mealTypeId: moving.mealTypeId };
    moving.dayOfWeek = ref.dayOfWeek;
    moving.mealTypeId = ref.mealTypeId;

    if (occupant) {
      occupant.dayOfWeek = from.dayOfWeek;
      occupant.mealTypeId = from.mealTypeId;
    }

    return drafts;
  });
}

/**
 * Copy an entry to another slot. This is how a user expresses leftovers before
 * prep links exist (phase 8).
 */
export async function duplicateEntry(
  ctx: ServiceContext,
  week: unknown,
  entryId: string,
  target: unknown,
): Promise<WriteResult> {
  const ref = slotRefSchema.parse(target);

  return mutateWeek(ctx, week, async (drafts, helpers) => {
    const source = helpers.requireDraft(drafts, entryId);
    resolvePlannableSlot(helpers.slots, ref);

    const taken = drafts
      .filter(
        (draft) =>
          draft.dayOfWeek === ref.dayOfWeek && draft.mealTypeId === ref.mealTypeId,
      )
      .map((draft) => draft.position);
    let position = 0;
    while (taken.includes(position)) position += 1;

    return [
      ...drafts,
      {
        dayOfWeek: ref.dayOfWeek,
        mealTypeId: ref.mealTypeId,
        recipeId: source.recipeId,
        recipeTitleSnapshot: source.recipeTitleSnapshot,
        recipeRevisionSnapshot: source.recipeRevisionSnapshot,
        servings: source.servings,
        note: source.note,
        rationale: null,
        rationaleRefs: null,
        position,
      },
    ];
  });
}

export async function updateEntry(
  ctx: ServiceContext,
  week: unknown,
  entryId: string,
  changes: { servings?: number; note?: string | null },
): Promise<WriteResult> {
  return mutateWeek(ctx, week, async (drafts, helpers) => {
    const target = helpers.requireDraft(drafts, entryId);
    if (changes.servings !== undefined) {
      if (!Number.isInteger(changes.servings) || changes.servings < 1) {
        throw new DomainError(
          "VALIDATION",
          "Le nombre de portions doit être un entier supérieur à zéro.",
          { servings: changes.servings },
        );
      }
      target.servings = changes.servings;
    }
    if (changes.note !== undefined) target.note = changes.note;
    return drafts;
  });
}

/**
 * Revert by replay: the chosen version's entries become a new version. The old
 * versions are never resurrected, so the history stays append-only and the
 * revert is itself revertible.
 */
export async function revertToVersion(
  ctx: ServiceContext,
  week: unknown,
  versionNumber: number,
): Promise<WriteResult> {
  return mutateWeek(ctx, week, async (_drafts, helpers) => {
    const source = helpers.versions.find(
      (version) => version.versionNumber === versionNumber,
    );
    if (!source) {
      throw new DomainError(
        "NOT_FOUND",
        `La version ${versionNumber} n'existe pas pour cette semaine. Versions disponibles : ${helpers.versions.map((version) => version.versionNumber).join(", ")}.`,
        {
          versionNumber,
          available: helpers.versions.map((version) => version.versionNumber),
        },
      );
    }

    const entries = await loadEntries(helpers.ctx, source.id);
    return entries.map((entry) => ({
      dayOfWeek: entry.dayOfWeek,
      mealTypeId: entry.mealTypeId,
      recipeId: entry.recipeId,
      recipeTitleSnapshot: entry.recipeTitleSnapshot,
      recipeRevisionSnapshot: entry.recipeRevisionSnapshot,
      servings: entry.servings,
      note: entry.note,
      rationale: entry.rationale,
      rationaleRefs: null,
      position: entry.position,
    }));
  });
}

interface MutationHelpers {
  readonly ctx: ServiceContext & { tx: NonNullable<ServiceContext["tx"]> };
  readonly slots: SlotDefinition[];
  readonly enforcement: EnforcementContext;
  readonly versions: Array<{ id: string; versionNumber: number; state: string }>;
  requireDraft(drafts: EntryDraft[], entryId: string): EntryDraft;
  requireRecipe(recipeId: string): Promise<RecipeForValidation>;
}

type Mutator = (
  drafts: EntryDraft[],
  helpers: MutationHelpers,
) => Promise<EntryDraft[]>;

/**
 * The single write path. Loads the active version, hands its entries to the
 * mutator as a working copy, validates the result as a whole, then writes a new
 * active version and supersedes the previous one.
 */
async function mutateWeek(
  ctx: ServiceContext,
  week: unknown,
  mutate: Mutator,
): Promise<WriteResult> {
  const isoWeek = isoWeekSchema.parse(week);

  return inScope(ctx, async (tx) => {
    const scoped = { ...ctx, tx };
    const slots = await loadSlotDefinitions(scoped);
    const enforcement = await loadEnforcementContext(scoped);

    const planRow = await ensurePlan(scoped, isoWeek);

    const versions = await tx
      .select({
        id: planVersion.id,
        versionNumber: planVersion.versionNumber,
        state: planVersion.state,
      })
      .from(planVersion)
      .where(eq(planVersion.planId, planRow.id))
      .orderBy(desc(planVersion.versionNumber));

    const active = versions.find((version) => version.state === "active");
    const current = active ? await loadEntries(scoped, active.id) : [];

    const drafts: EntryDraft[] = current.map((entry) => ({
      sourceEntryId: entry.id,
      dayOfWeek: entry.dayOfWeek,
      mealTypeId: entry.mealTypeId,
      recipeId: entry.recipeId,
      recipeTitleSnapshot: entry.recipeTitleSnapshot,
      recipeRevisionSnapshot: entry.recipeRevisionSnapshot,
      servings: entry.servings,
      note: entry.note,
      rationale: entry.rationale,
      rationaleRefs: null,
      position: entry.position,
    }));

    const recipeCache = new Map<string, RecipeForValidation>();
    const helpers: MutationHelpers = {
      ctx: scoped,
      slots,
      enforcement,
      versions,
      requireDraft: (list, entryId) => {
        const found = list.find((draft) => draft.sourceEntryId === entryId);
        if (!found) {
          throw new DomainError(
            "NOT_FOUND",
            `Aucune entrée ${entryId} dans la version active de cette semaine.`,
            { entryId },
          );
        }
        return found;
      },
      requireRecipe: async (recipeId) => {
        const cached = recipeCache.get(recipeId);
        if (cached) return cached;
        const loaded = await loadRecipesForValidation(scoped, [recipeId]);
        const found = loaded.get(recipeId);
        if (!found || found.recipe.deletedAt !== null) {
          throw new DomainError(
            "RECIPE_NOT_FOUND",
            `Aucune recette utilisable ne correspond à l'identifiant ${recipeId}. Elle n'existe pas ou a été supprimée. Recherchez une recette pour obtenir un identifiant valide.`,
            { recipeId },
          );
        }
        recipeCache.set(recipeId, found);
        return found;
      },
    };

    const next = await mutate(drafts, helpers);
    const warnings = await validateWeek(scoped, next, slots, enforcement);

    const nextNumber =
      versions.reduce((max, version) => Math.max(max, version.versionNumber), 0) +
      1;

    // Supersede first: a partial unique index allows only one active version
    // per plan, and it is checked per statement.
    if (active) {
      await tx
        .update(planVersion)
        .set({ state: "superseded" })
        .where(eq(planVersion.id, active.id));
    }

    const snapshot: SlotSnapshot = slots.map((slot) => ({
      dayOfWeek: slot.dayOfWeek,
      mealTypeId: slot.mealTypeId,
      mealTypeKey: slot.mealTypeKey,
      mealTypeLabel: slot.mealTypeLabel,
      state: slot.state,
      timeBudgetMin: slot.timeBudgetMin,
      defaultServings: slot.defaultServings,
    }));

    const createdRows = await tx
      .insert(planVersion)
      .values({
        userId: ctx.userId,
        planId: planRow.id,
        versionNumber: nextNumber,
        state: "active",
        createdBy: ctx.actor,
        createdByClientId: ctx.actor === "agent" ? (ctx.clientId ?? null) : null,
        slotSnapshot: snapshot,
        activatedAt: new Date(),
      })
      .returning();

    const created = createdRows[0]!;

    if (next.length > 0) {
      await tx.insert(planEntry).values(
        next.map((draft) => ({
          userId: ctx.userId,
          planVersionId: created.id,
          dayOfWeek: draft.dayOfWeek,
          mealTypeId: draft.mealTypeId,
          recipeId: draft.recipeId,
          recipeTitleSnapshot: draft.recipeTitleSnapshot,
          recipeRevisionSnapshot: draft.recipeRevisionSnapshot,
          servings: draft.servings,
          note: draft.note,
          rationale: draft.rationale,
          rationaleRefs: draft.rationaleRefs ?? null,
          position: draft.position,
        })),
      );
    }

    return {
      version: toVersionView(created),
      entries: await loadEntries(scoped, created.id),
      warnings,
    };
  });
}

/**
 * Validates the whole resulting week. Blocking rules throw; everything else is
 * collected and handed back for the caller to surface.
 */
async function validateWeek(
  ctx: ServiceContext & { tx: NonNullable<ServiceContext["tx"]> },
  drafts: readonly EntryDraft[],
  slots: readonly SlotDefinition[],
  enforcement: EnforcementContext,
): Promise<DomainWarning[]> {
  const warnings: DomainWarning[] = [];
  const recipeIds = [
    ...new Set(
      drafts
        .map((draft) => draft.recipeId)
        .filter((id): id is string => id !== null),
    ),
  ];
  const recipes = await loadRecipesForValidation(ctx, recipeIds);

  const equipmentOwned = new Set(enforcement.equipmentKeys);
  const seenRecipes = new Map<string, number>();

  for (const draft of drafts) {
    // An entry with no recipe is a deliberate placeholder, not a violation.
    if (draft.recipeId === null) continue;

    const slot = resolvePlannableSlot(slots, draft);
    const loaded = recipes.get(draft.recipeId);

    if (!loaded || loaded.recipe.deletedAt !== null) {
      throw new DomainError(
        "RECIPE_NOT_FOUND",
        `L'entrée de ${describeSlot(slot)} référence une recette introuvable ou supprimée (${draft.recipeId}). Remplacez-la ou videz ce créneau.`,
        { recipeId: draft.recipeId, slot: describeSlot(slot) },
      );
    }

    // The absolute rule. Re-run against live allergens on every write, never
    // trusted from the cached recipe.allergenIds.
    assertNoStrictAllergen(
      loaded.recipe.title,
      loaded.ingredientTexts,
      enforcement.allergens,
    );

    const budgetWarning = checkTimeBudget({
      activeTimeMin: activeTimeOf(loaded.recipe),
      slot,
      profileDefaultBudgetMin: enforcement.profile.defaultTimeBudgetMin,
      toleranceMin: enforcement.profile.timeBudgetToleranceMin,
    });
    if (budgetWarning) warnings.push(budgetWarning);

    warnings.push(
      ...collectIngredientWarnings(
        loaded.recipe.title,
        loaded.ingredientTexts,
        enforcement.allergens,
        enforcement.exclusions,
      ),
    );

    const missingEquipment = loaded.recipe.equipmentKeys.filter(
      (key) => !equipmentOwned.has(key),
    );
    if (missingEquipment.length > 0) {
      warnings.push({
        code: "EQUIPMENT_MISSING",
        message: `« ${loaded.recipe.title} » demande un équipement que vous n'avez pas déclaré : ${missingEquipment.join(", ")}.`,
        details: { recipeTitle: loaded.recipe.title, missingEquipment },
      });
    }

    seenRecipes.set(draft.recipeId, (seenRecipes.get(draft.recipeId) ?? 0) + 1);
  }

  // Repetition is only a problem for someone who said they dislike it.
  if (enforcement.profile.varietyPreference >= 4) {
    for (const [recipeId, count] of seenRecipes) {
      if (count < 2) continue;
      const title = recipes.get(recipeId)?.recipe.title ?? recipeId;
      warnings.push({
        code: "REPEAT_RECIPE_THIS_WEEK",
        message: `« ${title} » apparaît ${count} fois cette semaine, alors que votre préférence de variété est de ${enforcement.profile.varietyPreference} sur 5.`,
        details: { recipeId, count },
      });
    }
  }

  return warnings;
}

async function findPlan(
  ctx: ServiceContext & { tx: NonNullable<ServiceContext["tx"]> },
  isoWeek: IsoWeek,
) {
  const rows = await ctx.tx
    .select()
    .from(plan)
    .where(
      and(
        eq(plan.userId, ctx.userId),
        eq(plan.isoYear, isoWeek.year),
        eq(plan.isoWeek, isoWeek.week),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function ensurePlan(
  ctx: ServiceContext & { tx: NonNullable<ServiceContext["tx"]> },
  isoWeek: IsoWeek,
) {
  const existing = await findPlan(ctx, isoWeek);
  if (existing) return existing;

  const inserted = await ctx.tx
    .insert(plan)
    .values({
      userId: ctx.userId,
      isoYear: isoWeek.year,
      isoWeek: isoWeek.week,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return inserted[0];

  const reread = await findPlan(ctx, isoWeek);
  if (!reread) {
    throw new DomainError(
      "VALIDATION",
      `La semaine ${isoWeek.year}-W${isoWeek.week} n'a pas pu être créée.`,
      { year: isoWeek.year, week: isoWeek.week },
    );
  }
  return reread;
}

async function loadEntries(
  ctx: ServiceContext & { tx: NonNullable<ServiceContext["tx"]> },
  planVersionId: string,
): Promise<PlanEntryView[]> {
  const rows = await ctx.tx
    .select({
      id: planEntry.id,
      dayOfWeek: planEntry.dayOfWeek,
      mealTypeId: planEntry.mealTypeId,
      recipeId: planEntry.recipeId,
      recipeTitleSnapshot: planEntry.recipeTitleSnapshot,
      recipeRevisionSnapshot: planEntry.recipeRevisionSnapshot,
      servings: planEntry.servings,
      note: planEntry.note,
      rationale: planEntry.rationale,
      position: planEntry.position,
    })
    .from(planEntry)
    .where(eq(planEntry.planVersionId, planVersionId))
    .orderBy(asc(planEntry.dayOfWeek), asc(planEntry.position));

  return rows;
}

function toVersionView(row: typeof planVersion.$inferSelect): PlanVersionView {
  return {
    id: row.id,
    versionNumber: row.versionNumber,
    state: row.state,
    createdBy: row.createdBy,
    summary: row.summary,
    createdAt: row.createdAt,
    activatedAt: row.activatedAt,
  };
}

function slotKey(dayOfWeek: number, mealTypeId: string): string {
  return `${dayOfWeek}:${mealTypeId}`;
}

/** Total attended minutes per day, for the week screen's day headers. */
export function activeMinutesByDay(
  entries: readonly PlanEntryView[],
  activeTimeByRecipeId: ReadonlyMap<string, number | null>,
): Map<number, number> {
  const totals = new Map<number, number>();
  for (const entry of entries) {
    if (!entry.recipeId) continue;
    const minutes = activeTimeByRecipeId.get(entry.recipeId);
    if (minutes === null || minutes === undefined) continue;
    totals.set(entry.dayOfWeek, (totals.get(entry.dayOfWeek) ?? 0) + minutes);
  }
  return totals;
}
