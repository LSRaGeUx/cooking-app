import { and, eq, sql } from "drizzle-orm";
import { fact, planVersion } from "@/db/schema";
import { firstRow } from "@/db/rows";
import { DomainError } from "@/domain/errors";
import { assertPrepOrder, type PrepEndpoint } from "@/domain/prep";
import {
  isoWeekSchema,
  proposeWeekSchema,
  type RecipeInput,
} from "@/domain/schemas";
import { findSlot } from "@/domain/slots";
import { formatIsoWeek, type IsoDay, type IsoWeek } from "@/domain/week";
import type { FactStatus } from "@/domain/vocabulary";
import { baseUrl } from "@/lib/config";
import { inScope, type ScopedContext, type ServiceContext } from "./context";
import { linkIngredientNames } from "./ingredient-service";
import {
  entryKey,
  findPlan,
  findVersion,
  loadEntries,
  requirePendingVersion,
  toVersionView,
  type PlanEntryView,
  type PlanVersionView,
} from "./plan-queries";
import {
  defaultServingsFor,
  loadWriteContext,
  mutateWeek,
  requireMealType,
  toDraft,
  UUID_PATTERN,
  validateWeek,
  versionConflict,
  type EntryDraft,
  type ValidationReport,
  type WriteResult,
} from "./plan-writer";
import { linkPrepInVersion } from "./prep-service";
import { createRecipe, type RecipeForValidation } from "./recipe-service";

/**
 * The agent proposal lifecycle: propose, check, review, accept, reject.
 *
 * The shape of this file is the product argument of the whole project. An agent
 * writes a whole week in one call, the user reads a diff rather than a list of
 * seven dishes, and accepting is a state transition on the version the user
 * actually read rather than a fresh write nobody reviewed.
 */

export interface ProposalRow {
  readonly dayOfWeek: IsoDay;
  readonly mealTypeId: string;
  readonly mealTypeLabel: string;
  readonly position: number;
  /** How this dish differs from the active plan. */
  readonly status: "unchanged" | "changed" | "added" | "removed";
  readonly current: PlanEntryView | null;
  readonly proposed: PlanEntryView | null;
  /** Facts the agent cited, resolved so the user can follow and correct them. */
  readonly citedFacts: Array<{
    readonly id: string;
    readonly statement: string;
    readonly status: FactStatus;
  }>;
}

export interface ProposalReview {
  readonly isoWeek: IsoWeek;
  readonly version: PlanVersionView;
  readonly rows: ProposalRow[];
}

/**
 * The proposal, dish by dish, against what is planned today.
 *
 * The diff is the point of the screen. A list of seven dishes tells the user
 * nothing about what would change; "Tuesday moves from pasta to soup, Thursday
 * is new, the rest is untouched" is a decision they can make in ten seconds.
 *
 * Rows are keyed on `(dayOfWeek, mealTypeId, position)` and not on the slot.
 * Keyed on the slot, a slot holding two dishes was compared on whichever one
 * `find` returned first, so replacing the second dish of a Sunday lunch read as
 * "unchanged". Sorting is by the grid's own order rather than by day alone, so
 * lunch precedes dinner instead of landing in whichever order the rows arrived.
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

  return inScope(ctx, async (scoped) => {
    const planRow = await findPlan(scoped, isoWeek);
    if (!planRow) return null;

    const pending = await findVersion(scoped, planRow.id, "pending");
    if (!pending) return null;

    const active = await findVersion(scoped, planRow.id, "active");
    const proposedEntries = await loadEntries(scoped, pending.id);
    const currentEntries = active ? await loadEntries(scoped, active.id) : [];
    const { slots } = await loadWriteContext(scoped);

    const factsById = await loadCitedFacts(scoped, proposedEntries);

    const current = new Map(
      currentEntries.map((entry) => [entryKey(entry), entry]),
    );
    const proposed = new Map(
      proposedEntries.map((entry) => [entryKey(entry), entry]),
    );

    // The grid's order, so a row can be sorted by where its slot sits in the
    // week rather than by its day alone.
    const slotOrder = new Map(
      slots.map((slot, index) => [
        `${slot.dayOfWeek}:${slot.mealTypeId}`,
        index,
      ]),
    );
    const orderOf = (row: ProposalRow): number =>
      (slotOrder.get(`${row.dayOfWeek}:${row.mealTypeId}`) ??
        Number.MAX_SAFE_INTEGER) *
        100 +
      row.position;

    const rows: ProposalRow[] = [];
    for (const key of new Set([...current.keys(), ...proposed.keys()])) {
      const currentEntry = current.get(key) ?? null;
      const proposedEntry = proposed.get(key) ?? null;
      // One of the two is always present: the key came from one of the maps.
      const reference = proposedEntry ?? currentEntry;
      if (!reference) continue;

      const slot = findSlot(slots, reference);

      rows.push({
        dayOfWeek: reference.dayOfWeek,
        mealTypeId: reference.mealTypeId,
        mealTypeLabel: slot?.mealTypeLabel ?? "",
        position: reference.position,
        status:
          proposedEntry === null
            ? "removed"
            : currentEntry === null
              ? "added"
              : currentEntry.recipeId === proposedEntry.recipeId &&
                  currentEntry.servings === proposedEntry.servings
                ? "unchanged"
                : "changed",
        current: currentEntry,
        proposed: proposedEntry,
        citedFacts: (proposedEntry?.rationaleRefs ?? [])
          .map((ref) => factsById.get(ref))
          .filter((row): row is NonNullable<typeof row> => row !== undefined),
      });
    }

    rows.sort((a, b) => orderOf(a) - orderOf(b));

    return { isoWeek, version: toVersionView(pending), rows };
  });
}

async function loadCitedFacts(
  ctx: ScopedContext,
  entries: readonly PlanEntryView[],
): Promise<Map<string, { id: string; statement: string; status: FactStatus }>> {
  const factIds = [
    ...new Set(
      entries.flatMap((entry) =>
        entry.rationaleRefs.filter((ref) => UUID_PATTERN.test(ref)),
      ),
    ),
  ];
  if (factIds.length === 0) return new Map();

  const rows = await ctx.tx
    .select({ id: fact.id, statement: fact.statement, status: fact.status })
    .from(fact)
    .where(
      and(
        eq(fact.userId, ctx.userId),
        sql`${fact.id} = any(${sql.param(factIds)}::uuid[])`,
      ),
    );

  return new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        statement: row.statement,
        status: row.status as FactStatus,
      },
    ]),
  );
}

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
  const isoWeek: IsoWeek = { year: parsed.year, week: parsed.week };

  return inScope(ctx, async (scoped) => {
    const { enforcement } = await loadWriteContext(scoped);

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
          const mealType = requireMealType(helpers.mealTypes, entry.mealType);

          const recipeId =
            tempIdToRecipeId.get(entry.recipeRef) ?? entry.recipeRef;
          const recipe = await helpers.requireRecipe(recipeId);

          const key = `${entry.dayOfWeek}:${mealType.id}`;
          const position = takenPositions.get(key) ?? 0;
          takenPositions.set(key, position + 1);

          const slot = findSlot(helpers.slots, {
            dayOfWeek: entry.dayOfWeek,
            mealTypeId: mealType.id,
          });

          next.push({
            dayOfWeek: entry.dayOfWeek as IsoDay,
            mealTypeId: mealType.id,
            recipeId: recipe.recipe.id,
            recipeTitleSnapshot: recipe.recipe.title,
            recipeRevisionSnapshot: recipe.recipe.revision,
            servings: defaultServingsFor(
              entry.servings,
              slot,
              helpers.enforcement,
            ),
            note: entry.note,
            rationale: entry.rationale,
            rationaleRefs: entry.rationaleRefs,
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
    //
    // Through `linkPrepInVersion`, not `linkPrep`. The user-facing function
    // resolves both endpoints through the **active** week, and under the default
    // `proposal` authority the entries just written are `pending`: every
    // proposal carrying a prep link was therefore refused `NOT_FOUND` with
    // "doivent appartenir à la semaine active" and the whole transaction rolled
    // back. The entries are handed over directly instead.
    const warnings = [...result.warnings];
    for (const link of parsed.prepLinks) {
      const source = result.entries[link.sourceIndex];
      const dependent = result.entries[link.dependentIndex];
      if (!source || !dependent) {
        throw prepIndexError(link.sourceIndex, link.dependentIndex);
      }

      const linked = await linkPrepInVersion(scoped, isoWeek, result.entries, {
        sourceEntryId: source.id,
        dependentEntryId: dependent.id,
        servingsDrawn: link.servingsDrawn,
        note: link.note,
      });
      warnings.push(...linked.warnings);
    }

    return { ...result, warnings, reviewUrl: reviewUrlFor(isoWeek) };
  });
}

function prepIndexError(
  sourceIndex: number,
  dependentIndex: number,
): DomainError {
  return new DomainError(
    "VALIDATION",
    `Un lien de préparation référence une entrée inexistante (source ${sourceIndex}, dépendant ${dependentIndex}). Les indices portent sur le tableau \`entries\` du même appel.`,
    { sourceIndex, dependentIndex },
  );
}

/**
 * The same validation as `proposeWeek`, with nothing written.
 *
 * This is the highest leverage tool on the whole surface: it turns the rules
 * from a wall the agent hits into something it can consult, and it returns
 * every problem at once rather than the first one.
 *
 * It used to skip three of the checks the real call makes, so a green result
 * could still be refused. All three run now:
 *
 * - `expectedBaseVersion` is compared against the active version, so a stale
 *   base is reported here rather than discovered on the write.
 * - Positions are assigned per slot exactly as `proposeWeek` assigns them, so a
 *   multi-dish slot is validated as the write would build it. The old version
 *   put every entry at position 0.
 * - Prep link order is checked, and the indices are bounds-checked, so
 *   `PREP_LINK_ORDER` and the index error surface here too.
 *
 * One thing genuinely cannot be checked without writing, and it is reported
 * rather than pretended: the uniqueness of a **new** recipe's title, and
 * anything else the recipe insert itself could refuse. Nothing in the recipe
 * table constrains a title, so today that set is empty; if it stops being
 * empty, `newRecipes` will need a dry run of `createRecipe` and there is no
 * such thing.
 */
export async function checkFeasibility(
  ctx: ServiceContext,
  input: unknown,
): Promise<ValidationReport> {
  const parsed = proposeWeekSchema.parse(input);
  const isoWeek: IsoWeek = { year: parsed.year, week: parsed.week };

  return inScope(ctx, async (scoped) => {
    const { slots, enforcement, mealTypes } = await loadWriteContext(scoped);

    const errors: DomainError[] = [];
    const drafts: EntryDraft[] = [];

    // Recipes that do not exist yet are validated from the payload, so an agent
    // can find out that its invented dish breaks an allergen rule before it
    // creates anything.
    const virtual = new Map<string, RecipeForValidation>();
    for (const draft of parsed.newRecipes) {
      virtual.set(draft.tempId, await virtualRecipe(scoped, draft));
    }

    if (parsed.expectedBaseVersion !== null) {
      const active = await activeVersionNumber(scoped, isoWeek);
      if (parsed.expectedBaseVersion !== active) {
        errors.push(versionConflict(parsed.expectedBaseVersion, active));
      }
    }

    const takenPositions = new Map<string, number>();
    // Kept alongside the drafts so the prep-link pass can name the same meals
    // `proposeWeek` would have written, by their index in `entries`.
    const endpoints: Array<PrepEndpoint | null> = [];

    for (const entry of parsed.entries) {
      const mealType = capture(errors, () =>
        requireMealType(mealTypes, entry.mealType),
      );
      if (!mealType) {
        endpoints.push(null);
        continue;
      }

      const slot = findSlot(slots, {
        dayOfWeek: entry.dayOfWeek,
        mealTypeId: mealType.id,
      });

      const key = `${entry.dayOfWeek}:${mealType.id}`;
      const position = takenPositions.get(key) ?? 0;
      takenPositions.set(key, position + 1);

      const virtualHit = virtual.get(entry.recipeRef);
      // A reference that is neither a tempId of this call nor a uuid cannot be
      // looked up: it used to go into `inArray(recipe.id, ...)` and Postgres
      // raised `22P02` on the cast, which reaches an agent as an opaque
      // database failure. Named here instead, with the tempIds it could use.
      if (!virtualHit && !UUID_PATTERN.test(entry.recipeRef)) {
        errors.push(unknownRecipeRef(entry.recipeRef, [...virtual.keys()]));
        endpoints.push(null);
        continue;
      }

      const servings = defaultServingsFor(entry.servings, slot, enforcement);

      drafts.push({
        dayOfWeek: entry.dayOfWeek as IsoDay,
        mealTypeId: mealType.id,
        recipeId: entry.recipeRef,
        recipeTitleSnapshot: virtualHit?.recipe.title ?? "",
        recipeRevisionSnapshot: null,
        servings,
        note: entry.note,
        rationale: entry.rationale,
        rationaleRefs: entry.rationaleRefs,
        position,
      });

      endpoints.push({
        entryId: `${drafts.length - 1}`,
        dayOfWeek: entry.dayOfWeek,
        mealTypeLabel: slot?.mealTypeLabel ?? "",
        recipeTitle: virtualHit?.recipe.title ?? entry.recipeRef,
        servings,
        batchFriendly: virtualHit?.recipe.batchFriendly ?? false,
      });
    }

    for (const link of parsed.prepLinks) {
      const source = endpoints[link.sourceIndex];
      const dependent = endpoints[link.dependentIndex];
      if (!source || !dependent) {
        errors.push(prepIndexError(link.sourceIndex, link.dependentIndex));
        continue;
      }
      capture(errors, () => assertPrepOrder(source, dependent));
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

function unknownRecipeRef(
  received: string,
  tempIds: readonly string[],
): DomainError {
  return new DomainError(
    "RECIPE_NOT_FOUND",
    `« ${received} » n'est ni un identifiant de recette ni un \`temp_id\` déclaré dans \`newRecipes\` de cet appel. ${
      tempIds.length > 0
        ? `Identifiants temporaires déclarés : ${tempIds.join(", ")}.`
        : "Aucune recette n'est déclarée dans `newRecipes`."
    } Recherchez une recette pour obtenir un identifiant valide.`,
    { received, tempIds: [...tempIds] },
  );
}

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

async function activeVersionNumber(
  ctx: ScopedContext,
  isoWeek: IsoWeek,
): Promise<number | null> {
  const planRow = await findPlan(ctx, isoWeek);
  if (!planRow) return null;
  const active = await findVersion(ctx, planRow.id, "active");
  return active?.versionNumber ?? null;
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

  return inScope(ctx, async (scoped) => {
    const { tx } = scoped;
    const { planId, pending } = await requirePendingVersion(scoped, isoWeek);

    const entries = await loadEntries(scoped, pending.id);
    const { slots, enforcement } = await loadWriteContext(scoped);

    const report = await validateWeek(
      scoped,
      entries.map((entry) => toDraft(entry)),
      slots,
      enforcement,
    );
    if (report.errors[0]) throw report.errors[0];

    const active = await findVersion(scoped, planId, "active");
    if (active) {
      await tx
        .update(planVersion)
        .set({ state: "superseded" })
        .where(
          and(
            eq(planVersion.id, active.id),
            eq(planVersion.userId, ctx.userId),
          ),
        );
    }

    const activated = await tx
      .update(planVersion)
      .set({ state: "active", activatedAt: new Date() })
      .where(
        and(eq(planVersion.id, pending.id), eq(planVersion.userId, ctx.userId)),
      )
      .returning();

    return {
      version: toVersionView(firstRow(activated, "proposal activation")),
      entries: await loadEntries(scoped, pending.id),
      warnings: report.warnings,
    };
  });
}

/**
 * Accepting part of a proposal. The chosen entries are merged onto the active
 * week as a new version, and the proposal is consumed. Cherry-picking is the
 * common case: most proposals are right about four days out of seven.
 *
 * The chosen entries keep their `sourceEntryId`, which is what carries the prep
 * links the proposal created. Without it they were written as fresh rows and
 * every link inside the proposal was silently dropped on a partial accept,
 * while a full accept kept them: the same proposal behaved differently
 * depending on how much of it the user liked.
 */
export async function acceptPendingEntries(
  ctx: ServiceContext,
  week: unknown,
  entryIds: readonly string[],
): Promise<WriteResult> {
  const isoWeek = isoWeekSchema.parse(week);

  return inScope(ctx, async (scoped) => {
    const { tx } = scoped;
    const { pending } = await requirePendingVersion(scoped, isoWeek);

    const proposed = await loadEntries(scoped, pending.id);
    const chosen = proposed.filter((entry) => entryIds.includes(entry.id));
    if (chosen.length === 0) {
      throw new DomainError(
        "VALIDATION",
        "Aucune entrée sélectionnée. Choisissez au moins un repas, ou refusez la proposition.",
        { entryIds: [...entryIds] },
      );
    }

    const result = await mutateWeek(scoped, isoWeek, async (drafts) => {
      const replaced = new Set(
        chosen.map((entry) => `${entry.dayOfWeek}:${entry.mealTypeId}`),
      );
      const kept = drafts.filter(
        (draft) => !replaced.has(`${draft.dayOfWeek}:${draft.mealTypeId}`),
      );
      return [...kept, ...chosen.map((entry) => toDraft(entry))];
    });

    await tx
      .update(planVersion)
      .set({ state: "superseded" })
      .where(
        and(eq(planVersion.id, pending.id), eq(planVersion.userId, ctx.userId)),
      );

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

  return inScope(ctx, async (scoped) => {
    const { pending } = await requirePendingVersion(scoped, isoWeek);

    const rejected = await scoped.tx
      .update(planVersion)
      .set({
        state: "rejected",
        rejectionReason: reason?.trim() ? reason.trim() : null,
      })
      .where(
        and(eq(planVersion.id, pending.id), eq(planVersion.userId, ctx.userId)),
      )
      .returning();

    return toVersionView(firstRow(rejected, "proposal rejection"));
  });
}

/**
 * A recipe that exists only in a payload, shaped so the same allergen and time
 * rules can run against it.
 *
 * The ingredient names are linked before the rules run. Without that the
 * virtual recipe carried `rawName` alone, so a strict allergen that matches only
 * an alias of a linked ingredient passed `check_feasibility` and was then
 * blocked by `propose_week`, which links the names as it creates the recipe.
 * A feasibility check that misses the one absolute block in the system is worse
 * than no check.
 */
async function virtualRecipe(
  ctx: ScopedContext,
  input: { tempId: string } & RecipeInput,
): Promise<RecipeForValidation> {
  const links = await linkIngredientNames(
    ctx,
    input.ingredients.map((line) => line.rawName),
  );
  const vocabulary = await loadVocabulary(ctx, links);

  return {
    recipe: {
      id: input.tempId,
      userId: ctx.userId,
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
      revision: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    },
    ingredientTexts: input.ingredients.map((line) => {
      const linked = links.get(line.rawName);
      const known = linked ? vocabulary.get(linked.id) : undefined;
      return {
        rawName: line.rawName,
        canonicalName: known?.canonicalName ?? null,
        aliases: known?.aliases ?? null,
      };
    }),
  };
}

/** The canonical names and aliases of the entries a virtual recipe linked to. */
async function loadVocabulary(
  ctx: ScopedContext,
  links: Map<string, { id: string }>,
): Promise<Map<string, { canonicalName: string; aliases: string[] }>> {
  const ids = [...new Set([...links.values()].map((match) => match.id))];
  if (ids.length === 0) return new Map();

  const rows = await ctx.tx.execute<{
    id: string;
    canonical_name: string;
    aliases: string[];
  }>(sql`
    select id, canonical_name, aliases
    from ingredient
    where user_id = ${ctx.userId}
      and id = any(${sql.param(ids)}::uuid[])
  `);

  return new Map(
    rows.rows.map((row) => [
      row.id,
      { canonicalName: row.canonical_name, aliases: row.aliases },
    ]),
  );
}

/**
 * The deep link the agent hands back. Through `baseUrl()`, which is required in
 * production: reading `process.env.BETTER_AUTH_URL` with a silent localhost
 * fallback meant a deployed instance handed agents a dead link, and ESLint now
 * refuses `process.env` outside src/lib/config.ts for exactly that reason.
 */
function reviewUrlFor(isoWeek: IsoWeek): string {
  return `${baseUrl()}/semaine/${formatIsoWeek(isoWeek)}/proposition`;
}
