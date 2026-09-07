import { and, eq, inArray, sql } from "drizzle-orm";
import { planEntry, planVersion, prepLink } from "@/db/schema";
import { firstRow } from "@/db/rows";
import {
  assertNoStrictAllergen,
  collectIngredientWarnings,
} from "@/domain/allergens";
import { DomainError, type DomainWarning } from "@/domain/errors";
import { isoWeekSchema, type SlotSnapshot } from "@/domain/schemas";
import {
  activeTimeOf,
  checkTimeBudget,
  describeSlot,
  findSlot,
  resolvePlannableSlot,
  type SlotDefinition,
} from "@/domain/slots";
import type { IsoDay } from "@/domain/week";
import { inScope, type ScopedContext, type ServiceContext } from "./context";
import {
  ensurePlan,
  entryKey,
  loadEntries,
  listVersionRows,
  toVersionView,
  type PlanEntryView,
  type PlanVersionView,
} from "./plan-queries";
import {
  loadEnforcementContext,
  type EnforcementContext,
} from "./profile-service";
import {
  loadRecipesForValidation,
  type RecipeForValidation,
} from "./recipe-service";
import { listMealTypes, loadSlotDefinitions } from "./slot-service";

/**
 * The write core of planning. The load-bearing rule of the whole codebase lives
 * here: a plan version is immutable, so every edit writes a new version and
 * supersedes the old one. That is what makes an agent proposal reviewable, a
 * bad week revertible, and the history of a plan honest.
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

export interface WriteResult {
  readonly version: PlanVersionView;
  readonly entries: PlanEntryView[];
  readonly warnings: DomainWarning[];
}

/** The mutable working copy a mutation operates on. */
export interface EntryDraft {
  /** The row this draft came from in the previous version, when it had one. */
  sourceEntryId?: string;
  dayOfWeek: IsoDay;
  mealTypeId: string;
  recipeId: string | null;
  recipeTitleSnapshot: string;
  recipeRevisionSnapshot: number | null;
  servings: number;
  note: string | null;
  rationale: string | null;
  /**
   * The cited fact, feedback and pantry ids. Typed rather than `unknown`, which
   * is what let three separate hand-written mappings drop it silently: every
   * one of them wrote `rationaleRefs: null`, and `unknown` accepts that. Never
   * null now, because the column is `not null default '[]'`.
   */
  rationaleRefs: string[];
  position: number;
}

export interface ToDraftOptions {
  /**
   * Whether the draft keeps a link back to the row it came from.
   *
   * The link drives two things after the write: feedback and prep links are
   * re-pointed at the new row, and `validateWeek` treats a draft with no source
   * as new in this write. `false` is for a copy that is deliberately a new
   * meal, such as `duplicateEntry`.
   */
  readonly keepSource?: boolean;
  /** Overrides, for the caller that copies an entry into another slot. */
  readonly dayOfWeek?: IsoDay;
  readonly mealTypeId?: string;
  readonly position?: number;
  readonly rationale?: string | null;
}

/**
 * One entry as a draft.
 *
 * This existed three times, hand-written, with different fields, and that
 * duplication was the direct cause of two defects. All three wrote
 * `rationaleRefs: null`, so the first edit after a proposal, every partial
 * accept and every revert erased the fact ids the agent had cited, which is the
 * data the review screen's "correct the reason instead of the dish" mechanism
 * is made of. Two of them also omitted `sourceEntryId`, so the feedback and
 * prep-link remap never ran for a revert or for a re-proposal, and every
 * recorded verdict was detached from the active week.
 */
export function toDraft(
  entry: PlanEntryView,
  options: ToDraftOptions = {},
): EntryDraft {
  const draft: EntryDraft = {
    dayOfWeek: options.dayOfWeek ?? entry.dayOfWeek,
    mealTypeId: options.mealTypeId ?? entry.mealTypeId,
    recipeId: entry.recipeId,
    recipeTitleSnapshot: entry.recipeTitleSnapshot,
    recipeRevisionSnapshot: entry.recipeRevisionSnapshot,
    servings: entry.servings,
    note: entry.note,
    rationale:
      options.rationale === undefined ? entry.rationale : options.rationale,
    rationaleRefs: [...entry.rationaleRefs],
    position: options.position ?? entry.position,
  };
  if (options.keepSource !== false) draft.sourceEntryId = entry.id;
  return draft;
}

/** `servings ?? the slot's default ?? the profile's default`, written once. */
export function defaultServingsFor(
  servings: number | null | undefined,
  slot: Pick<SlotDefinition, "defaultServings"> | undefined,
  enforcement: EnforcementContext,
): number {
  return (
    servings ?? slot?.defaultServings ?? enforcement.profile.defaultServings
  );
}

/**
 * The meal type a caller named by key, or `SLOT_UNKNOWN` listing the valid
 * keys.
 *
 * Four call sites built this error, and one of them was in an MCP tool: the
 * `update_slot` handler resolved the key itself because `assignRecipe` and
 * `clearSlot` only took an id, which put a business rule on one entry point and
 * not the other (CLAUDE.md rule 3). The lookup and the sentence live here now,
 * and both entry points reach it.
 *
 * Note that this `SLOT_UNKNOWN` lists meal-type keys while the one
 * `resolvePlannableSlot` raises lists plannable slots. Both are correct for what
 * they refuse: an unknown key and a known key in an unplannable position are
 * different mistakes, and an agent told the wrong one of the two corrects the
 * wrong thing.
 */
export function requireMealType(
  mealTypes: ReadonlyArray<{ id: string; key: string }>,
  key: string,
): { id: string; key: string } {
  const found = mealTypes.find((type) => type.key === key);
  if (found) return found;
  const valid = mealTypes.map((type) => type.key);
  throw new DomainError(
    "SLOT_UNKNOWN",
    `Aucun type de repas ne porte la clé « ${key} ». Clés valides : ${valid.join(", ") || "aucune"}. La ressource « cooking://slots » donne les créneaux planifiables avec ces clés.`,
    { received: key, valid },
  );
}

export interface MutationHelpers {
  readonly ctx: ScopedContext;
  readonly slots: SlotDefinition[];
  readonly enforcement: EnforcementContext;
  readonly mealTypes: ReadonlyArray<{ id: string; key: string }>;
  readonly versions: Array<{
    id: string;
    versionNumber: number;
    state: string;
  }>;
  requireDraft(drafts: EntryDraft[], entryId: string): EntryDraft;
  requireRecipe(recipeId: string): Promise<RecipeForValidation>;
}

export type Mutator = (
  drafts: EntryDraft[],
  helpers: MutationHelpers,
) => Promise<EntryDraft[]>;

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

/**
 * A uuid, as Postgres will accept one.
 *
 * Exported because the proposal service tests a `recipeRef` against it before
 * the value can reach `inArray(recipe.id, ...)`. A reference that is neither a
 * tempId nor a uuid used to go straight into that query, and Postgres raised
 * `22P02` on the cast, which reaches an agent as an opaque database failure
 * instead of the `RECIPE_NOT_FOUND` that names the tempIds it could have used.
 */
export const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * The single write path. Loads the active version, hands its entries to the
 * mutator as a working copy, validates the result as a whole, then writes a new
 * active version and supersedes the previous one.
 */
export async function mutateWeek(
  ctx: ServiceContext,
  week: unknown,
  mutate: Mutator,
  options: MutateOptions = {},
): Promise<WriteResult> {
  const isoWeek = isoWeekSchema.parse(week);

  return inScope(ctx, async (scoped) => {
    const { tx } = scoped;
    const { slots, enforcement, mealTypes } = await loadWriteContext(scoped);

    // Locked, because the version number below is read-modify-write and the
    // partial unique indexes allow one active and one pending version.
    const planRow = await ensurePlan(scoped, isoWeek, { lock: true });

    const versions = (await listVersionRows(scoped, planRow.id)).map(
      (version) => ({
        id: version.id,
        versionNumber: version.versionNumber,
        state: version.state,
      }),
    );

    const active = versions.find((version) => version.state === "active");

    if (options.expectedBaseVersion !== undefined) {
      const current = active?.versionNumber ?? null;
      if (options.expectedBaseVersion !== current) {
        throw versionConflict(options.expectedBaseVersion, current);
      }
    }

    const startFrom =
      options.startEmpty === true || !active
        ? []
        : await loadEntries(scoped, active.id);

    const drafts: EntryDraft[] = startFrom.map((entry) => toDraft(entry));

    const recipeCache = new Map<string, RecipeForValidation>();
    const helpers: MutationHelpers = {
      ctx: scoped,
      slots,
      enforcement,
      mealTypes,
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
        if (!UUID_PATTERN.test(recipeId)) throw recipeNotFound(recipeId);
        const loaded = await loadRecipesForValidation(scoped, [recipeId]);
        const found = loaded.get(recipeId);
        if (!found || found.recipe.deletedAt !== null) {
          throw recipeNotFound(recipeId);
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
      versions.reduce(
        (max, version) => Math.max(max, version.versionNumber),
        0,
      ) + 1;

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

    const created = firstRow(
      await tx
        .insert(planVersion)
        .values({
          userId: ctx.userId,
          planId: planRow.id,
          versionNumber: nextNumber,
          state: targetState,
          createdBy: ctx.actor,
          createdByClientId:
            ctx.actor === "agent" ? (ctx.clientId ?? null) : null,
          summary: options.summary ?? null,
          slotSnapshot: snapshot,
          activatedAt: targetState === "active" ? new Date() : null,
        })
        .returning(),
      "plan version insert",
    );

    if (next.length > 0) {
      const insertedEntries = await tx
        .insert(planEntry)
        .values(
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
            // Never null: the column is `not null default '[]'::jsonb`.
            rationaleRefs: draft.rationaleRefs,
            position: draft.position,
          })),
        )
        .returning({ id: planEntry.id });

      await carryForward(scoped, startFrom, next, insertedEntries);
    }

    return {
      version: toVersionView(created),
      entries: await loadEntries(scoped, created.id),
      warnings,
    };
  });
}

export function versionConflict(
  expected: number | null,
  current: number | null,
): DomainError {
  return new DomainError(
    "VERSION_CONFLICT",
    `Cette semaine a changé depuis votre lecture : vous partez de la version ${expected ?? "aucune"}, la version active est ${current ?? "aucune"}. Relisez la semaine et reproposez à partir de son état actuel plutôt que d'écraser ce qui a été fait entre-temps.`,
    { expected, current },
  );
}

export function recipeNotFound(recipeId: string): DomainError {
  return new DomainError(
    "RECIPE_NOT_FOUND",
    `Aucune recette utilisable ne correspond à l'identifiant ${recipeId}. Elle n'existe pas, a été supprimée, ou la référence n'est ni un identifiant de recette ni un \`temp_id\` déclaré dans \`newRecipes\` du même appel. Recherchez une recette pour obtenir un identifiant valide.`,
    { recipeId },
  );
}

/**
 * Re-points what belonged to the old rows at the new ones.
 *
 * Feedback belongs to what happened in a slot this week, not to one revision of
 * the plan, and a prep link names two entries. Without this, editing a week
 * after cooking silently orphans every verdict the user recorded, and every
 * batch-cooking link with it. See docs/02-data-model.md section 6.
 *
 * The mapping is by `sourceEntryId` first and by slot position second. Two of
 * the three draft builders used to omit the source id entirely, so a revert and
 * a `direct` re-proposal carried nothing forward: both rebuild the same meals
 * in the same slots, which is exactly what the positional fallback recognises.
 * It is a fallback rather than the rule because a slot can hold several dishes
 * and a source id is unambiguous where a position is only usually right.
 *
 * Both remaps are one statement each, against `update ... from (values ...)`.
 * They were a loop issuing one UPDATE per carried entry, which for a seven-day
 * week is fourteen round trips inside the transaction that holds the plan lock.
 */
async function carryForward(
  ctx: ScopedContext,
  previous: readonly PlanEntryView[],
  drafts: readonly EntryDraft[],
  inserted: ReadonlyArray<{ id: string }>,
): Promise<void> {
  const { tx } = ctx;

  const bySlot = new Map<string, PlanEntryView>();
  for (const entry of previous) bySlot.set(entryKey(entry), entry);

  const oldToNew = new Map<string, string>();
  for (const [index, draft] of drafts.entries()) {
    const newId = inserted[index]?.id;
    if (!newId) continue;
    const oldId = draft.sourceEntryId ?? bySlot.get(entryKey(draft))?.id;
    if (!oldId) continue;
    // A slot match can only be claimed once, so two new dishes in one slot do
    // not both inherit the same verdict.
    if (oldToNew.has(oldId)) continue;
    oldToNew.set(oldId, newId);
  }

  if (oldToNew.size === 0) return;

  const oldIds = [...oldToNew.keys()];

  await tx.execute(sql`
    update entry_feedback f
    set plan_entry_id = m.new_id
    from (values ${sql.join(
      oldIds.map(
        (oldId) => sql`(${oldId}::uuid, ${oldToNew.get(oldId)}::uuid)`,
      ),
      sql`, `,
    )}) as m(old_id, new_id)
    where f.plan_entry_id = m.old_id
      and f.user_id = ${ctx.userId}
  `);

  // A prep link names two entries, and the two ends do not move together: the
  // dependent always carries forward, because that is what put the link in the
  // mapping, while a source that did not survive leaves the link unsourced
  // rather than deleting the dependent meal, which the user still intends to
  // eat. Both new values are therefore computed per link and applied in one
  // statement, rather than as three passes that would each be right about one
  // case and wrong about another.
  const carried = await tx
    .select()
    .from(prepLink)
    .where(
      and(
        eq(prepLink.userId, ctx.userId),
        inArray(prepLink.dependentEntryId, oldIds),
      ),
    );

  const moves = carried.flatMap((link) => {
    const newDependent = oldToNew.get(link.dependentEntryId);
    if (!newDependent) return [];
    const newSource = link.sourceEntryId
      ? (oldToNew.get(link.sourceEntryId) ?? null)
      : null;
    return [sql`(${link.id}::uuid, ${newDependent}::uuid, ${newSource}::uuid)`];
  });
  if (moves.length === 0) return;

  await tx.execute(sql`
    update prep_link l
    set dependent_entry_id = m.new_dependent,
        source_entry_id = m.new_source
    from (values ${sql.join(moves, sql`, `)})
      as m(id, new_dependent, new_source)
    where l.id = m.id
      and l.user_id = ${ctx.userId}
  `);
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

/** Runs one rule, keeping the failure instead of letting it stop the sweep. */
function capture<T>(errors: DomainError[], rule: () => T): T | undefined {
  try {
    return rule();
  } catch (error) {
    if (error instanceof DomainError) {
      errors.push(error);
      return undefined;
    }
    throw error;
  }
}

/**
 * Validates the whole resulting week and returns everything wrong with it.
 *
 * It collects rather than throwing, because `check_feasibility` exists to hand
 * an agent every problem at once. A validator that stops at the first failure
 * turns one round trip into five, and the callers that do need to refuse simply
 * throw the first error themselves.
 */
export async function validateWeek(
  ctx: ScopedContext,
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
            id !== null &&
            !options.virtualRecipes?.has(id) &&
            UUID_PATTERN.test(id),
        ),
    ),
  ];
  const stored = await loadRecipesForValidation(ctx, recipeIds);
  const recipes = new Map([...stored, ...(options.virtualRecipes ?? [])]);

  const equipmentOwned = new Set(enforcement.equipmentKeys);
  const seenRecipes = new Map<string, number>();

  for (const draft of drafts) {
    // An entry with no recipe is a deliberate placeholder, not a violation.
    if (draft.recipeId === null) continue;

    // Only entries this write is introducing. An inherited entry the user
    // typed by hand has no rationale and does not need one, so requiring it
    // everywhere would stop an agent touching a hand-planned week.
    const isNewInThisWrite = draft.sourceEntryId === undefined;

    /**
     * A planned slot is required of a new entry only.
     *
     * Every draft used to go through `resolvePlannableSlot`, so once a slot
     * holding an entry was set to `skipped` or `hidden`, every later edit of
     * that week failed `SLOT_NOT_PLANNED` about a slot the caller had not
     * touched, and stayed broken until the orphan was cleared. An inherited
     * orphan is a configuration change made after the fact rather than a rule
     * the writer broke, so the entry is carried and the write proceeds.
     *
     * It is not silent either. `getWeekView` separates exactly these rows into
     * `orphanedEntries`, which is the surface the user already sees them on, and
     * the write returns a `SLOT_NO_LONGER_PLANNED` warning so an agent, which
     * never sees that screen, is told the meal it just carried is in a slot the
     * grid will not show.
     *
     * A draft whose meal type has left the grid entirely is skipped: nothing
     * can be said about its budget or its label, and the row is carried forward
     * regardless so the meal is not lost.
     */
    let resolvedSlot: SlotDefinition | undefined;
    if (isNewInThisWrite) {
      resolvedSlot = capture(errors, () => resolvePlannableSlot(slots, draft));
      if (!resolvedSlot) continue;
    } else {
      resolvedSlot = findSlot(slots, draft);
      if (!resolvedSlot) continue;
      if (resolvedSlot.state !== "planned") {
        warnings.push({
          code: "SLOT_NO_LONGER_PLANNED",
          message:
            `${describeSlot(resolvedSlot)} n'est plus un créneau planifié, mais ` +
            "le repas qui s'y trouvait est conservé. Videz le créneau, ou " +
            "remettez-le en `planned` pour le voir réapparaître dans la grille.",
          details: {
            slot: describeSlot(resolvedSlot),
            slotState: resolvedSlot.state,
          },
        });
      }
    }

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

    if (
      options.requireRationale &&
      isNewInThisWrite &&
      !draft.rationale?.trim()
    ) {
      errors.push(
        new DomainError(
          "MISSING_RATIONALE",
          `L'entrée de ${describeSlot(resolvedSlot)} (« ${loaded.recipe.title} ») n'a pas de justification. Chaque repas que vous proposez doit dire pourquoi il est là : quel fait, quelle contrainte de temps ou quelle préférence l'a motivé. Sans cela l'utilisateur ne peut corriger que le plat, pas la raison.`,
          {
            slot: describeSlot(resolvedSlot),
            recipeTitle: loaded.recipe.title,
          },
        ),
      );
    }

    // The absolute rule. Re-run against live allergens on every write, never
    // trusted from a cached list on the recipe.
    capture(errors, () =>
      assertNoStrictAllergen(
        loaded.recipe.title,
        loaded.ingredientTexts,
        enforcement.allergens,
      ),
    );

    // The verdict is a value now rather than a mixed throw-or-return contract,
    // so the two outcomes are read here instead of one of them aborting the
    // sweep from inside a callback. `exceeded` blocks, `tight` warns.
    const verdict = checkTimeBudget({
      activeTimeMin: activeTimeOf(loaded.recipe),
      slot: resolvedSlot,
      profileDefaultBudgetMin: enforcement.profile.defaultTimeBudgetMin,
      toleranceMin: enforcement.profile.timeBudgetToleranceMin,
    });
    if (verdict.kind === "exceeded") errors.push(verdict.error);
    else if (verdict.kind === "tight") warnings.push(verdict.warning);

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
        details: {
          recipeId,
          recipeTitle: title,
          count,
          varietyPreference: enforcement.profile.varietyPreference,
        },
      });
    }
  }

  return { errors, warnings };
}

export interface WriteContext {
  readonly slots: SlotDefinition[];
  readonly enforcement: EnforcementContext;
  readonly mealTypes: Array<{ id: string; key: string }>;
}

/**
 * The three reads every write and every feasibility check opens with, in one
 * round of queries. Sequential rather than parallel: they run on one
 * transaction, and there is no parallelism to win on a single connection.
 */
export async function loadWriteContext(
  ctx: ScopedContext,
): Promise<WriteContext> {
  const slots = await loadSlotDefinitions(ctx);
  const enforcement = await loadEnforcementContext(ctx);
  const mealTypes = (await listMealTypes(ctx)).map((type) => ({
    id: type.id,
    key: type.key,
  }));
  return { slots, enforcement, mealTypes };
}
