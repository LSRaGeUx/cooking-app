import { DomainError } from "@/domain/errors";
import {
  planEntryInputSchema,
  planEntryPatchSchema,
  slotRefSchema,
  type PlanEntryInput,
  type SlotRefInput,
} from "@/domain/schemas";
import { resolvePlannableSlot } from "@/domain/slots";
import type { IsoDay } from "@/domain/week";
import { inScope, type ScopedContext, type ServiceContext } from "./context";
import { loadEntries, slotKey } from "./plan-queries";
import {
  defaultServingsFor,
  mutateWeek,
  requireMealType,
  toDraft,
  UUID_PATTERN,
  type EntryDraft,
  type WriteResult,
} from "./plan-writer";
import { listMealTypes } from "./slot-service";

/**
 * Planning, from a person's own hands: assign a dish, clear a slot, drag one
 * entry onto another, revert a week.
 *
 * This file used to be 1510 lines holding four concerns, and the split is
 * along the lines those concerns already had:
 *
 * - `plan-queries.ts` reads plans. The prep service needs it too, and the two
 *   used to import each other.
 * - `plan-writer.ts` is `mutateWeek` and `validateWeek`, the one write path
 *   every edit goes through and the one validator every write runs.
 * - `proposal-service.ts` is the agent lifecycle: propose, check, review,
 *   accept, reject.
 * - this file is the user's edits.
 *
 * Everything the previous module exported is re-exported at the bottom, so no
 * caller outside `src/services` has to move.
 */

/**
 * A slot may be named by meal-type key as well as by id.
 *
 * `update_slot` used to resolve the key to an id inside the MCP tool and pass
 * the id in, which put the lookup and its `SLOT_UNKNOWN` on the agent path and
 * nowhere else: the web path never ran either, which is what rule 3 forbids.
 * The resolution happens here now, and both entry points get it.
 *
 * A `mealTypeId` that is not a uuid is treated as a key too, so a caller that
 * puts `"dinner"` in the id field gets `SLOT_UNKNOWN` naming the valid keys
 * rather than a Postgres `22P02` on the uuid cast. When the value already is a
 * uuid nothing is read: the early return is what keeps this free for the
 * screens, which always hold ids.
 *
 * The result is handed to the domain schema, which is still the only thing that
 * validates it (rule 9). Nothing here decides what a valid slot reference is.
 */
async function resolveMealTypeRef(
  ctx: ScopedContext,
  input: unknown,
): Promise<unknown> {
  if (typeof input !== "object" || input === null) return input;
  const raw = input as Record<string, unknown>;

  const key =
    typeof raw.mealTypeKey === "string"
      ? raw.mealTypeKey
      : typeof raw.mealTypeId === "string" && !UUID_PATTERN.test(raw.mealTypeId)
        ? raw.mealTypeId
        : null;
  if (key === null) return input;

  const resolved = requireMealType(await listMealTypes(ctx), key);
  const { mealTypeKey: _key, ...rest } = raw;
  return { ...rest, mealTypeId: resolved.id };
}

export async function assignRecipe(
  ctx: ServiceContext,
  week: unknown,
  input: unknown,
): Promise<WriteResult> {
  return inScope(ctx, async (scoped) => {
    const entry = planEntryInputSchema.parse(
      await resolveMealTypeRef(scoped, input),
    );
    return assignParsed(scoped, week, entry);
  });
}

async function assignParsed(
  ctx: ServiceContext,
  week: unknown,
  entry: PlanEntryInput,
): Promise<WriteResult> {
  return mutateWeek(
    ctx,
    week,
    async (drafts, helpers) => {
      const slot = resolvePlannableSlot(helpers.slots, entry);
      const recipe = await helpers.requireRecipe(entry.recipeId);

      const next = drafts.filter(
        (draft) =>
          !(
            draft.dayOfWeek === entry.dayOfWeek &&
            draft.mealTypeId === entry.mealTypeId &&
            draft.position === entry.position
          ),
      );

      next.push({
        dayOfWeek: slot.dayOfWeek,
        mealTypeId: entry.mealTypeId,
        recipeId: recipe.recipe.id,
        recipeTitleSnapshot: recipe.recipe.title,
        recipeRevisionSnapshot: recipe.recipe.revision,
        servings: defaultServingsFor(entry.servings, slot, helpers.enforcement),
        note: entry.note,
        rationale: entry.rationale,
        rationaleRefs: entry.rationaleRefs,
        position: entry.position,
      });

      return next;
    },
    { requireRationale: ctx.actor === "agent" },
  );
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
  return inScope(ctx, async (scoped) => {
    const ref = slotRefSchema.parse(await resolveMealTypeRef(scoped, slotRef));
    return mutateWeek(scoped, week, async (drafts) =>
      drafts.filter(
        (draft) =>
          slotKey(draft.dayOfWeek, draft.mealTypeId) !==
          slotKey(ref.dayOfWeek, ref.mealTypeId),
      ),
    );
  });
}

/**
 * Drag between slots. A drop on an occupied slot swaps the two entries, which
 * is the behaviour a grid implies and the only one that is its own undo.
 *
 * The target accepts a meal-type key as well as an id, like every other
 * slot-reference argument in this file, so the rule is the same wherever a
 * caller names a slot.
 */
export async function moveEntry(
  ctx: ServiceContext,
  week: unknown,
  entryId: string,
  target: unknown,
): Promise<WriteResult> {
  return inScope(ctx, async (scoped) => {
    const ref = slotRefSchema.parse(await resolveMealTypeRef(scoped, target));
    return moveParsed(scoped, week, entryId, ref);
  });
}

async function moveParsed(
  ctx: ServiceContext,
  week: unknown,
  entryId: string,
  ref: SlotRefInput,
): Promise<WriteResult> {
  return mutateWeek(ctx, week, async (drafts, helpers) => {
    const moving = helpers.requireDraft(drafts, entryId);
    const slot = resolvePlannableSlot(helpers.slots, ref);

    const occupant = drafts.find(
      (draft) =>
        draft !== moving &&
        draft.dayOfWeek === ref.dayOfWeek &&
        draft.mealTypeId === ref.mealTypeId &&
        draft.position === moving.position,
    );

    const from = { dayOfWeek: moving.dayOfWeek, mealTypeId: moving.mealTypeId };
    moving.dayOfWeek = slot.dayOfWeek;
    moving.mealTypeId = ref.mealTypeId;

    if (occupant) {
      occupant.dayOfWeek = from.dayOfWeek;
      occupant.mealTypeId = from.mealTypeId;
    }

    return drafts;
  });
}

/**
 * Copy an entry to another slot, for the cook who plans the same dish twice.
 *
 * The copy deliberately does not keep a `sourceEntryId`: it is a new meal, so
 * it must not inherit the original's recorded verdict or its prep link. It
 * drops the rationale for the same reason, since the reason the agent gave for
 * Tuesday is not a reason for Thursday.
 */
export async function duplicateEntry(
  ctx: ServiceContext,
  week: unknown,
  entryId: string,
  target: unknown,
): Promise<WriteResult> {
  return inScope(ctx, async (scoped) => {
    const ref = slotRefSchema.parse(await resolveMealTypeRef(scoped, target));
    return duplicateParsed(scoped, week, entryId, ref);
  });
}

async function duplicateParsed(
  ctx: ServiceContext,
  week: unknown,
  entryId: string,
  ref: SlotRefInput,
): Promise<WriteResult> {
  return mutateWeek(ctx, week, async (drafts, helpers) => {
    const source = helpers.requireDraft(drafts, entryId);
    const slot = resolvePlannableSlot(helpers.slots, ref);

    const taken = drafts
      .filter(
        (draft) =>
          slotKey(draft.dayOfWeek, draft.mealTypeId) ===
          slotKey(ref.dayOfWeek, ref.mealTypeId),
      )
      .map((draft) => draft.position);
    let position = 0;
    while (taken.includes(position)) position += 1;

    const copy: EntryDraft = {
      dayOfWeek: slot.dayOfWeek,
      mealTypeId: ref.mealTypeId,
      recipeId: source.recipeId,
      recipeTitleSnapshot: source.recipeTitleSnapshot,
      recipeRevisionSnapshot: source.recipeRevisionSnapshot,
      servings: source.servings,
      note: source.note,
      rationale: null,
      rationaleRefs: [],
      position,
    };

    return [...drafts, copy];
  });
}

/**
 * Servings and the note, the two fields that can change without changing which
 * dish is in the slot.
 *
 * Validated by `planEntryPatchSchema` rather than by hand. The hand-written
 * check tested that servings was a positive integer and nothing else, so the
 * maximum of 50 and the note length of 500 that the schema declares, and that
 * the MCP surface publishes, were not enforced on this path at all.
 */
export async function updateEntry(
  ctx: ServiceContext,
  week: unknown,
  entryId: string,
  changes: unknown,
): Promise<WriteResult> {
  const patch = planEntryPatchSchema.parse(changes);

  return mutateWeek(ctx, week, async (drafts, helpers) => {
    const target = helpers.requireDraft(drafts, entryId);
    if (patch.servings !== undefined) target.servings = patch.servings;
    if (patch.note !== undefined) target.note = patch.note;
    return drafts;
  });
}

/**
 * Revert by replay: the chosen version's entries become a new version. The old
 * versions are never resurrected, so the history stays append-only and the
 * revert is itself revertible.
 *
 * The replayed entries carry the ids they had in the version being reverted to,
 * which is deliberate and is what makes the positional fallback in
 * `carryForward` fire: those ids are not in the active version, so the feedback
 * and prep links are re-pointed by `(day, meal, position)` instead. Without
 * either, reverting a week after cooking detached every verdict the user had
 * recorded from the active week.
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
      const available = helpers.versions.map(
        (version) => version.versionNumber,
      );
      throw new DomainError(
        "NOT_FOUND",
        `La version ${versionNumber} n'existe pas pour cette semaine. Versions disponibles : ${available.join(", ")}.`,
        { versionNumber, available },
      );
    }

    const entries = await loadEntries(helpers.ctx, source.id);
    return entries.map((entry) => toDraft(entry));
  });
}

/**
 * Total attended minutes per day, for the week screen's day headers.
 *
 * A pure function over a view and a lookup table, with no database access and
 * no service dependency, so it belongs in src/domain/slots.ts next to
 * `activeTimeOf`. It is left here rather than moved because that file is the
 * domain agent's; it has no caller today either way.
 */
export function activeMinutesByDay(
  entries: readonly { dayOfWeek: IsoDay; recipeId: string | null }[],
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

/**
 * The public surface this module used to carry, re-exported so no caller
 * outside `src/services` has to follow the split. Anything importing
 * `@/services/plan-service` keeps working; new code inside the service layer
 * should import from the module that owns the symbol.
 */
export {
  getWeekView,
  listVersions,
  getVersionEntries,
  type PlanEntryView,
  type PlanVersionView,
  type WeekView,
} from "./plan-queries";

export { type ValidationReport, type WriteResult } from "./plan-writer";

export {
  acceptPendingEntries,
  acceptPendingVersion,
  checkFeasibility,
  getProposalReview,
  proposeWeek,
  rejectPendingVersion,
  type ProposalReview,
  type ProposalRow,
  type ProposeResult,
} from "./proposal-service";
