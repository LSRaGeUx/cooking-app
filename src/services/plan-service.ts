import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  entryFeedback,
  fact,
  plan,
  planEntry,
  planVersion,
  prepLink,
} from "@/db/schema";
import {
  assertNoStrictAllergen,
  collectIngredientWarnings,
} from "@/domain/allergens";
import { DomainError, type DomainWarning } from "@/domain/errors";
import {
  isoWeekSchema,
  planEntryInputSchema,
  proposeWeekSchema,
  slotRefSchema,
  type RecipeInput,
  type SlotSnapshot,
} from "@/domain/schemas";
import {
  activeTimeOf,
  checkTimeBudget,
  describeSlot,
  findSlot,
  resolvePlannableSlot,
  type SlotDefinition,
} from "@/domain/slots";
import { formatIsoWeek, type IsoWeek } from "@/domain/week";
import { inScope, type ServiceContext } from "./context";
import { loadEnforcementContext, type EnforcementContext } from "./profile-service";
import {
  createRecipe,
  loadRecipesForValidation,
  type RecipeForValidation,
} from "./recipe-service";
import { linkPrep } from "./prep-service";
import { listMealTypes, loadSlotDefinitions } from "./slot-service";

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
  /** Fact, feedback or pantry ids the agent cited when it chose this dish. */
  readonly rationaleRefs: string[] | null;
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
      rationale: entry.rationale,
      rationaleRefs:
        entry.rationaleRefs.length > 0 ? entry.rationaleRefs : null,
      position: entry.position,
    });

    return next;
  }, { requireRationale: ctx.actor === "agent" });
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

export interface ProposalRow {
  readonly dayOfWeek: number;
  readonly mealTypeId: string;
  readonly mealTypeLabel: string;
  /** How this slot differs from the active plan. */
  readonly status: "unchanged" | "changed" | "added" | "removed";
  readonly current: PlanEntryView | null;
  readonly proposed: PlanEntryView | null;
  /** Facts the agent cited, resolved so the user can follow and correct them. */
  readonly citedFacts: Array<{
    readonly id: string;
    readonly statement: string;
    readonly status: string;
  }>;
}

export interface ProposalReview {
  readonly isoWeek: IsoWeek;
  readonly version: PlanVersionView;
  readonly rows: ProposalRow[];
}

/**
 * The proposal, slot by slot, against what is planned today.
 *
 * The diff is the point of the screen. A list of seven dishes tells the user
 * nothing about what would change; "Tuesday moves from pasta to soup, Thursday
 * is new, the rest is untouched" is a decision they can make in ten seconds.
 *
 * Cited facts are resolved rather than shown as identifiers, because the whole
 * argument for requiring a rationale is that the user can correct the reason
 * instead of the dish.
 */
export async function getProposalReview(
  ctx: ServiceContext,
  week: unknown,
): Promise<ProposalReview | null> {
  const isoWeek = isoWeekSchema.parse(week);

  return inScope(ctx, async (tx) => {
    const scoped = { ...ctx, tx };
    const planRow = await findPlan(scoped, isoWeek);
    if (!planRow) return null;

    const pending = await findVersion(scoped, planRow.id, "pending");
    if (!pending) return null;

    const active = await findVersion(scoped, planRow.id, "active");
    const proposedEntries = await loadEntries(scoped, pending.id);
    const currentEntries = active ? await loadEntries(scoped, active.id) : [];
    const slots = await loadSlotDefinitions(scoped);

    const factIds = [
      ...new Set(
        proposedEntries.flatMap((entry) =>
          (entry.rationaleRefs ?? []).filter((ref) => UUID_PATTERN.test(ref)),
        ),
      ),
    ];
    const facts =
      factIds.length === 0
        ? []
        : await tx
            .select({
              id: fact.id,
              statement: fact.statement,
              status: fact.status,
            })
            .from(fact)
            .where(
              and(
                eq(fact.userId, ctx.userId),
                sql`${fact.id} = any(${sql.param(factIds)}::uuid[])`,
              ),
            );
    const factsById = new Map(facts.map((row) => [row.id, row]));

    const keys = new Set<string>([
      ...currentEntries.map((entry) => slotKey(entry.dayOfWeek, entry.mealTypeId)),
      ...proposedEntries.map((entry) => slotKey(entry.dayOfWeek, entry.mealTypeId)),
    ]);

    const rows: ProposalRow[] = [];
    for (const key of keys) {
      const current =
        currentEntries.find(
          (entry) => slotKey(entry.dayOfWeek, entry.mealTypeId) === key,
        ) ?? null;
      const proposed =
        proposedEntries.find(
          (entry) => slotKey(entry.dayOfWeek, entry.mealTypeId) === key,
        ) ?? null;

      const reference = proposed ?? current!;
      const slot = slots.find(
        (candidate) =>
          candidate.dayOfWeek === reference.dayOfWeek &&
          candidate.mealTypeId === reference.mealTypeId,
      );

      rows.push({
        dayOfWeek: reference.dayOfWeek,
        mealTypeId: reference.mealTypeId,
        mealTypeLabel: slot?.mealTypeLabel ?? "",
        status:
          proposed === null
            ? "removed"
            : current === null
              ? "added"
              : current.recipeId === proposed.recipeId &&
                  current.servings === proposed.servings
                ? "unchanged"
                : "changed",
        current,
        proposed,
        citedFacts: (proposed?.rationaleRefs ?? [])
          .map((ref) => factsById.get(ref))
          .filter((row): row is NonNullable<typeof row> => row !== undefined),
      });
    }

    rows.sort((a, b) => a.dayOfWeek - b.dayOfWeek);

    return { isoWeek, version: toVersionView(pending), rows };
  });
}

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export interface ProposeResult extends WriteResult {
  /** Deep link the agent hands the user in chat. The handoff back to the app. */
  readonly reviewUrl: string;
}

/**
 * The central write. One call, one transaction: recipes the agent invented are
 * created and assigned together, so a partial failure cannot leave eight
 * orphaned recipes and no plan.
 *
 * Whether the result applies immediately or waits for the user is the profile's
 * authority setting, read here and never taken from the payload. An agent that
 * could choose would be escalating its own permission.
 */
export async function proposeWeek(
  ctx: ServiceContext,
  input: unknown,
): Promise<ProposeResult> {
  const parsed = proposeWeekSchema.parse(input);
  const isoWeek = { year: parsed.year, week: parsed.week };

  return inScope(ctx, async (tx) => {
    const scoped = { ...ctx, tx };
    const enforcement = await loadEnforcementContext(scoped);
    const mealTypes = await listMealTypes(scoped);

    const state =
      ctx.actor === "agent" && enforcement.profile.agentAuthority === "proposal"
        ? "pending"
        : "active";

    // Created before validation, inside the same transaction. If anything below
    // throws, these disappear with it.
    const tempIdToRecipeId = new Map<string, string>();
    for (const draft of parsed.newRecipes) {
      const { tempId, ...recipeInput } = draft;
      const created = await createRecipe(scoped, recipeInput);
      tempIdToRecipeId.set(tempId, created.recipe.id);
    }

    const result = await mutateWeek(
      scoped,
      isoWeek,
      async (_drafts, helpers) => {
        const next: EntryDraft[] = [];
        const takenPositions = new Map<string, number>();

        for (const entry of parsed.entries) {
          const mealType = mealTypes.find((type) => type.key === entry.mealType);
          if (!mealType) {
            throw new DomainError(
              "SLOT_UNKNOWN",
              `Aucun type de repas ne porte la clé « ${entry.mealType} ». Clés valides : ${mealTypes.map((type) => type.key).join(", ")}.`,
              {
                received: entry.mealType,
                valid: mealTypes.map((type) => type.key),
              },
            );
          }

          const recipeId =
            tempIdToRecipeId.get(entry.recipeRef) ?? entry.recipeRef;
          const recipe = await helpers.requireRecipe(recipeId);

          const slotKeyed = `${entry.dayOfWeek}:${mealType.id}`;
          const position = takenPositions.get(slotKeyed) ?? 0;
          takenPositions.set(slotKeyed, position + 1);

          const slot = findSlot(helpers.slots, {
            dayOfWeek: entry.dayOfWeek,
            mealTypeId: mealType.id,
          });

          next.push({
            dayOfWeek: entry.dayOfWeek,
            mealTypeId: mealType.id,
            recipeId: recipe.recipe.id,
            recipeTitleSnapshot: recipe.recipe.title,
            recipeRevisionSnapshot: recipe.recipe.revision,
            servings:
              entry.servings ??
              slot?.defaultServings ??
              enforcement.profile.defaultServings,
            note: entry.note,
            rationale: entry.rationale,
            rationaleRefs:
              entry.rationaleRefs.length > 0 ? entry.rationaleRefs : null,
            position,
          });
        }

        return next;
      },
      {
        state,
        summary: parsed.summary,
        expectedBaseVersion: parsed.expectedBaseVersion,
        requireRationale: ctx.actor === "agent",
        // A proposal is a whole week, not a patch on one.
        startEmpty: true,
      },
    );

    // Prep links are created after the entries exist, in the same transaction,
    // so a refused week leaves no links behind either.
    const warnings = [...result.warnings];
    for (const link of parsed.prepLinks) {
      const source = result.entries[link.sourceIndex];
      const dependent = result.entries[link.dependentIndex];
      if (!source || !dependent) {
        throw new DomainError(
          "VALIDATION",
          `Un lien de préparation référence une entrée inexistante (source ${link.sourceIndex}, dépendant ${link.dependentIndex}). Les indices portent sur le tableau \`entries\` du même appel.`,
          { sourceIndex: link.sourceIndex, dependentIndex: link.dependentIndex },
        );
      }

      const linked = await linkPrep(scoped, isoWeek, {
        sourceEntryId: source.id,
        dependentEntryId: dependent.id,
        ...(link.servingsDrawn === null
          ? {}
          : { servingsDrawn: link.servingsDrawn }),
        note: link.note,
      });
      warnings.push(...linked.warnings);
    }

    return { ...result, warnings, reviewUrl: reviewUrlFor(isoWeek) };
  });
}

/**
 * The same validation as `proposeWeek`, with nothing written.
 *
 * This is the highest leverage tool on the whole surface: it turns the rules
 * from a wall the agent hits into something it can consult, and it returns
 * every problem at once rather than the first one.
 */
export async function checkFeasibility(
  ctx: ServiceContext,
  input: unknown,
): Promise<ValidationReport> {
  const parsed = proposeWeekSchema.parse(input);

  return inScope(ctx, async (tx) => {
    const scoped = { ...ctx, tx };
    const enforcement = await loadEnforcementContext(scoped);
    const slots = await loadSlotDefinitions(scoped);
    const mealTypes = await listMealTypes(scoped);

    const errors: DomainError[] = [];
    const drafts: EntryDraft[] = [];

    // Recipes that do not exist yet are validated from the payload, so an agent
    // can find out that its invented dish breaks an allergen rule before it
    // creates anything.
    const virtual = new Map<string, RecipeForValidation>();
    for (const draft of parsed.newRecipes) {
      virtual.set(draft.tempId, virtualRecipe(ctx.userId, draft));
    }

    for (const entry of parsed.entries) {
      const mealType = mealTypes.find((type) => type.key === entry.mealType);
      if (!mealType) {
        errors.push(
          new DomainError(
            "SLOT_UNKNOWN",
            `Aucun type de repas ne porte la clé « ${entry.mealType} ». Clés valides : ${mealTypes.map((type) => type.key).join(", ")}.`,
            {
              received: entry.mealType,
              valid: mealTypes.map((type) => type.key),
            },
          ),
        );
        continue;
      }

      const recipeId = entry.recipeRef;
      const slot = findSlot(slots, {
        dayOfWeek: entry.dayOfWeek,
        mealTypeId: mealType.id,
      });

      drafts.push({
        dayOfWeek: entry.dayOfWeek,
        mealTypeId: mealType.id,
        recipeId,
        recipeTitleSnapshot: virtual.get(recipeId)?.recipe.title ?? "",
        recipeRevisionSnapshot: null,
        servings:
          entry.servings ??
          slot?.defaultServings ??
          enforcement.profile.defaultServings,
        note: entry.note,
        rationale: entry.rationale,
        rationaleRefs: null,
        position: 0,
      });
    }

    const report = await validateWeek(scoped, drafts, slots, enforcement, {
      requireRationale: ctx.actor === "agent",
      virtualRecipes: virtual,
    });

    return {
      errors: [...errors, ...report.errors],
      warnings: report.warnings,
    };
  });
}

/**
 * Accepting a proposal is a state transition, not a new version: the version
 * the user reviewed is the one that becomes active, unchanged.
 *
 * It is revalidated first. A proposal written last week against last week's
 * allergen list must not become the active plan today if an allergen has been
 * added since, and no path may ever activate a plan the rules would refuse.
 */
export async function acceptPendingVersion(
  ctx: ServiceContext,
  week: unknown,
): Promise<WriteResult> {
  const isoWeek = isoWeekSchema.parse(week);

  return inScope(ctx, async (tx) => {
    const scoped = { ...ctx, tx };
    const planRow = await findPlan(scoped, isoWeek);
    const pending = planRow ? await findVersion(scoped, planRow.id, "pending") : null;
    if (!planRow || !pending) {
      throw new DomainError(
        "NOT_FOUND",
        "Aucune proposition en attente pour cette semaine.",
        isoWeek,
      );
    }

    const entries = await loadEntries(scoped, pending.id);
    const slots = await loadSlotDefinitions(scoped);
    const enforcement = await loadEnforcementContext(scoped);

    const report = await validateWeek(
      scoped,
      entries.map(toDraft),
      slots,
      enforcement,
    );
    if (report.errors[0]) throw report.errors[0];

    const active = await findVersion(scoped, planRow.id, "active");
    if (active) {
      await tx
        .update(planVersion)
        .set({ state: "superseded" })
        .where(eq(planVersion.id, active.id));
    }

    const activated = await tx
      .update(planVersion)
      .set({ state: "active", activatedAt: new Date() })
      .where(eq(planVersion.id, pending.id))
      .returning();

    return {
      version: toVersionView(activated[0]!),
      entries: await loadEntries(scoped, pending.id),
      warnings: report.warnings,
    };
  });
}

/**
 * Accepting part of a proposal. The chosen entries are merged onto the active
 * week as a new version, and the proposal is consumed. Cherry-picking is the
 * common case: most proposals are right about four days out of seven.
 */
export async function acceptPendingEntries(
  ctx: ServiceContext,
  week: unknown,
  entryIds: readonly string[],
): Promise<WriteResult> {
  const isoWeek = isoWeekSchema.parse(week);

  return inScope(ctx, async (tx) => {
    const scoped = { ...ctx, tx };
    const planRow = await findPlan(scoped, isoWeek);
    const pending = planRow ? await findVersion(scoped, planRow.id, "pending") : null;
    if (!planRow || !pending) {
      throw new DomainError(
        "NOT_FOUND",
        "Aucune proposition en attente pour cette semaine.",
        isoWeek,
      );
    }

    const proposed = await loadEntries(scoped, pending.id);
    const chosen = proposed.filter((entry) => entryIds.includes(entry.id));
    if (chosen.length === 0) {
      throw new DomainError(
        "VALIDATION",
        "Aucune entrée sélectionnée. Choisissez au moins un repas, ou refusez la proposition.",
        { entryIds },
      );
    }

    const result = await mutateWeek(scoped, isoWeek, async (drafts) => {
      const replacedSlots = new Set(
        chosen.map((entry) => `${entry.dayOfWeek}:${entry.mealTypeId}`),
      );
      const kept = drafts.filter(
        (draft) => !replacedSlots.has(`${draft.dayOfWeek}:${draft.mealTypeId}`),
      );
      return [...kept, ...chosen.map(toDraft)];
    });

    await tx
      .update(planVersion)
      .set({ state: "superseded" })
      .where(eq(planVersion.id, pending.id));

    return result;
  });
}

/**
 * Rejecting, with the reason kept. The reason is the highest quality signal the
 * product ever gets: it is the user saying, in their own words, what was wrong
 * with a personalized suggestion.
 */
export async function rejectPendingVersion(
  ctx: ServiceContext,
  week: unknown,
  reason: string | null,
): Promise<PlanVersionView> {
  const isoWeek = isoWeekSchema.parse(week);

  return inScope(ctx, async (tx) => {
    const scoped = { ...ctx, tx };
    const planRow = await findPlan(scoped, isoWeek);
    const pending = planRow ? await findVersion(scoped, planRow.id, "pending") : null;
    if (!planRow || !pending) {
      throw new DomainError(
        "NOT_FOUND",
        "Aucune proposition en attente pour cette semaine.",
        isoWeek,
      );
    }

    const rejected = await tx
      .update(planVersion)
      .set({
        state: "rejected",
        rejectionReason: reason?.trim() ? reason.trim() : null,
      })
      .where(eq(planVersion.id, pending.id))
      .returning();

    return toVersionView(rejected[0]!);
  });
}

async function findVersion(
  ctx: ServiceContext & { tx: NonNullable<ServiceContext["tx"]> },
  planId: string,
  state: string,
) {
  const rows = await ctx.tx
    .select()
    .from(planVersion)
    .where(and(eq(planVersion.planId, planId), eq(planVersion.state, state)))
    .limit(1);
  return rows[0] ?? null;
}

function toDraft(entry: PlanEntryView): EntryDraft {
  return {
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
  };
}

/**
 * A recipe that exists only in a payload, shaped so the same allergen and time
 * rules can run against it.
 */
function virtualRecipe(
  userId: string,
  input: { tempId: string } & RecipeInput,
): RecipeForValidation {
  return {
    recipe: {
      id: input.tempId,
      userId,
      title: input.title,
      description: input.description,
      imageUrl: null,
      source: "agent",
      sourceUrl: null,
      sourceClientId: null,
      servings: input.servings,
      prepTimeMin: input.prepTimeMin,
      cookTimeMin: input.cookTimeMin,
      activeTimeMin: input.activeTimeMin,
      batchFriendly: input.batchFriendly,
      keepsDays: input.keepsDays,
      tags: input.tags,
      cuisine: input.cuisine,
      mainProtein: input.mainProtein,
      difficulty: input.difficulty,
      equipmentKeys: input.equipmentKeys,
      allergenIds: [],
      revision: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    },
    ingredientTexts: input.ingredients.map((line) => ({
      rawName: line.rawName,
      canonicalName: null,
      aliases: null,
    })),
  };
}

function reviewUrlFor(isoWeek: IsoWeek): string {
  const base = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
  return `${base}/semaine/${formatIsoWeek(isoWeek)}/proposition`;
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
export interface MutateOptions {
  /**
   * `active` applies straight away; `pending` waits for the user. Which one an
   * agent gets is the authority setting, read from the profile, never from the
   * payload: an agent that could choose would be escalating its own permission.
   */
  readonly state?: "active" | "pending";
  readonly summary?: string | null;
  /**
   * Optimistic concurrency. When given, the active version must still be this
   * number, or the write is refused with the current state attached so the
   * caller can rebase instead of asking a human.
   */
  readonly expectedBaseVersion?: number | null;
  readonly requireRationale?: boolean;
  readonly virtualRecipes?: ReadonlyMap<string, RecipeForValidation>;
  /** Start from an empty week rather than from the active version's entries. */
  readonly startEmpty?: boolean;
}

async function mutateWeek(
  ctx: ServiceContext,
  week: unknown,
  mutate: Mutator,
  options: MutateOptions = {},
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

    if (options.expectedBaseVersion !== undefined) {
      const current = active?.versionNumber ?? null;
      if (options.expectedBaseVersion !== current) {
        throw new DomainError(
          "VERSION_CONFLICT",
          `Cette semaine a changé depuis votre lecture : vous partez de la version ${options.expectedBaseVersion ?? "aucune"}, la version active est ${current ?? "aucune"}. Relisez la semaine et reproposez à partir de son état actuel plutôt que d'écraser ce qui a été fait entre-temps.`,
          { expected: options.expectedBaseVersion, current },
        );
      }
    }

    const startFrom =
      options.startEmpty === true || !active
        ? []
        : await loadEntries(scoped, active.id);

    const drafts: EntryDraft[] = startFrom.map((entry) => ({
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
    const report = await validateWeek(scoped, next, slots, enforcement, {
      ...(options.requireRationale === undefined
        ? {}
        : { requireRationale: options.requireRationale }),
      ...(options.virtualRecipes === undefined
        ? {}
        : { virtualRecipes: options.virtualRecipes }),
    });

    // A write refuses on the first problem. Callers that want the whole list
    // ask checkFeasibility, which is the same validator without the write.
    if (report.errors[0]) throw report.errors[0];
    const warnings = report.warnings;

    const targetState = options.state ?? "active";
    const nextNumber =
      versions.reduce((max, version) => Math.max(max, version.versionNumber), 0) +
      1;

    // Supersede first: partial unique indexes allow only one active and one
    // pending version per plan, and they are checked per statement. A pending
    // proposal supersedes an earlier pending one and leaves the active plan
    // alone, which is what makes a proposal safe to ignore.
    const replaced =
      targetState === "active"
        ? active
        : versions.find((version) => version.state === "pending");

    if (replaced) {
      await tx
        .update(planVersion)
        .set({ state: "superseded" })
        .where(eq(planVersion.id, replaced.id));
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
        state: targetState,
        createdBy: ctx.actor,
        createdByClientId: ctx.actor === "agent" ? (ctx.clientId ?? null) : null,
        summary: options.summary ?? null,
        slotSnapshot: snapshot,
        activatedAt: targetState === "active" ? new Date() : null,
      })
      .returning();

    const created = createdRows[0]!;

    if (next.length > 0) {
      const insertedEntries = await tx.insert(planEntry).values(
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
      ).returning({ id: planEntry.id });

      // Feedback belongs to what happened in a slot this week, not to one
      // revision of the plan. Without this, editing a week after cooking would
      // silently orphan every verdict the user recorded.
      const oldToNew = new Map<string, string>();
      for (const [index, draft] of next.entries()) {
        const newId = insertedEntries[index]?.id;
        if (!draft.sourceEntryId || !newId) continue;
        oldToNew.set(draft.sourceEntryId, newId);
        await tx
          .update(entryFeedback)
          .set({ planEntryId: newId })
          .where(eq(entryFeedback.planEntryId, draft.sourceEntryId));
      }

      // Prep links point at two entries, so both ends are remapped. A source
      // that did not survive leaves the link unsourced rather than deleting the
      // dependent meal, which the user still intends to eat.
      if (oldToNew.size > 0) {
        const carried = await tx
          .select()
          .from(prepLink)
          .where(
            inArray(prepLink.dependentEntryId, [...oldToNew.keys()]),
          );

        for (const link of carried) {
          const newDependent = oldToNew.get(link.dependentEntryId);
          if (!newDependent) continue;
          const newSource = link.sourceEntryId
            ? (oldToNew.get(link.sourceEntryId) ?? null)
            : null;
          await tx
            .update(prepLink)
            .set({ dependentEntryId: newDependent, sourceEntryId: newSource })
            .where(eq(prepLink.id, link.id));
        }
      }
    }

    return {
      version: toVersionView(created),
      entries: await loadEntries(scoped, created.id),
      warnings,
    };
  });
}

export interface ValidationReport {
  readonly errors: DomainError[];
  readonly warnings: DomainWarning[];
}

interface ValidateOptions {
  /** Agent-written entries must say why. A user's may be silent. */
  readonly requireRationale?: boolean;
  /**
   * Recipes that do not exist yet, keyed by the reference used in the entries.
   * `check_feasibility` and `propose_week` both let an agent reason about
   * dishes it is inventing, so the allergen and time rules have to be able to
   * run against a recipe that is still only a payload.
   */
  readonly virtualRecipes?: ReadonlyMap<string, RecipeForValidation>;
}

/**
 * Validates the whole resulting week and returns everything wrong with it.
 *
 * It collects rather than throwing, because `check_feasibility` exists to hand
 * an agent every problem at once. A validator that stops at the first failure
 * turns one round trip into five, and the callers that do need to refuse simply
 * throw the first error themselves.
 */
async function validateWeek(
  ctx: ServiceContext & { tx: NonNullable<ServiceContext["tx"]> },
  drafts: readonly EntryDraft[],
  slots: readonly SlotDefinition[],
  enforcement: EnforcementContext,
  options: ValidateOptions = {},
): Promise<ValidationReport> {
  const errors: DomainError[] = [];
  const warnings: DomainWarning[] = [];

  const recipeIds = [
    ...new Set(
      drafts
        .map((draft) => draft.recipeId)
        .filter(
          (id): id is string =>
            id !== null && !options.virtualRecipes?.has(id),
        ),
    ),
  ];
  const stored = await loadRecipesForValidation(ctx, recipeIds);
  const recipes = new Map([...stored, ...(options.virtualRecipes ?? [])]);

  const equipmentOwned = new Set(enforcement.equipmentKeys);
  const seenRecipes = new Map<string, number>();

  /** Runs one rule, keeping the failure instead of letting it stop the sweep. */
  function capture(rule: () => void): boolean {
    try {
      rule();
      return true;
    } catch (error) {
      if (error instanceof DomainError) {
        errors.push(error);
        return false;
      }
      throw error;
    }
  }

  for (const draft of drafts) {
    // An entry with no recipe is a deliberate placeholder, not a violation.
    if (draft.recipeId === null) continue;

    let slot: SlotDefinition | null = null;
    if (!capture(() => void (slot = resolvePlannableSlot(slots, draft)))) {
      continue;
    }
    // Narrowed by the capture above, which returns false when it throws.
    const resolvedSlot = slot as unknown as SlotDefinition;

    const loaded = recipes.get(draft.recipeId);
    if (!loaded || loaded.recipe.deletedAt !== null) {
      errors.push(
        new DomainError(
          "RECIPE_NOT_FOUND",
          `L'entrée de ${describeSlot(resolvedSlot)} référence une recette introuvable ou supprimée (${draft.recipeId}). Remplacez-la, ou videz ce créneau.`,
          { recipeId: draft.recipeId, slot: describeSlot(resolvedSlot) },
        ),
      );
      continue;
    }

    // Only entries this write is introducing. An inherited entry the user
    // typed by hand has no rationale and does not need one, so requiring it
    // everywhere would stop an agent touching a hand-planned week.
    const isNewInThisWrite = draft.sourceEntryId === undefined;
    if (options.requireRationale && isNewInThisWrite && !draft.rationale?.trim()) {
      errors.push(
        new DomainError(
          "MISSING_RATIONALE",
          `L'entrée de ${describeSlot(resolvedSlot)} (« ${loaded.recipe.title} ») n'a pas de justification. Chaque repas que vous proposez doit dire pourquoi il est là : quel fait, quelle contrainte de temps ou quelle préférence l'a motivé. Sans cela l'utilisateur ne peut corriger que le plat, pas la raison.`,
          { slot: describeSlot(resolvedSlot), recipeTitle: loaded.recipe.title },
        ),
      );
    }

    // The absolute rule. Re-run against live allergens on every write, never
    // trusted from the cached recipe.allergenIds.
    capture(() =>
      assertNoStrictAllergen(
        loaded.recipe.title,
        loaded.ingredientTexts,
        enforcement.allergens,
      ),
    );

    capture(() => {
      const budgetWarning = checkTimeBudget({
        activeTimeMin: activeTimeOf(loaded.recipe),
        slot: resolvedSlot,
        profileDefaultBudgetMin: enforcement.profile.defaultTimeBudgetMin,
        toleranceMin: enforcement.profile.timeBudgetToleranceMin,
      });
      if (budgetWarning) warnings.push(budgetWarning);
    });

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

  return { errors, warnings };
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
      rationaleRefs: planEntry.rationaleRefs,
      position: planEntry.position,
    })
    .from(planEntry)
    .where(eq(planEntry.planVersionId, planVersionId))
    .orderBy(asc(planEntry.dayOfWeek), asc(planEntry.position));

  return rows.map((row) => ({
    ...row,
    rationaleRefs: Array.isArray(row.rationaleRefs)
      ? (row.rationaleRefs as string[])
      : null,
  }));
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
