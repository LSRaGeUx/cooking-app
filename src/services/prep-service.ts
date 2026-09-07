import { and, eq, inArray, isNull } from "drizzle-orm";
import { prepLink } from "@/db/schema";
import { firstRow } from "@/db/rows";
import { DomainError, type DomainWarning } from "@/domain/errors";
import {
  assertPrepOrder,
  checkBatchFriendly,
  type PrepEndpoint,
} from "@/domain/prep";
import {
  isoWeekSchema,
  prepLinkInputSchema,
  type PrepLinkInput,
} from "@/domain/schemas";
import { formatIsoWeek, type IsoWeek } from "@/domain/week";
import type { SlotDefinition } from "@/domain/slots";
import { inScope, type ScopedContext, type ServiceContext } from "./context";
import { getWeekView, type PlanEntryView } from "./plan-queries";
import { loadRecipeSummaries } from "./recipe-service";
import { loadSlotDefinitions } from "./slot-service";

/**
 * Prep links: which cooking session feeds which meal.
 *
 * The links live between plan entries, which belong to an immutable version, so
 * the planning service re-creates them when it copies a week forward. A source
 * that disappears leaves the link in place with no source rather than deleting
 * the dependent meal, which the user still intends to eat.
 *
 * There are two doors into the same rules, and the difference is which entries
 * count as "the week". `linkPrep` resolves them through the active week, which
 * is what a person clicking in the grid means. `linkPrepInVersion` is handed
 * the entries, which is what a proposal needs: its rows are `pending` under the
 * default authority, so the active week does not contain them and every
 * proposal carrying a prep link used to be refused `NOT_FOUND` and rolled back.
 * Both call `applyLink` below, so the rules cannot diverge between them.
 */

export interface PrepLinkView {
  readonly id: string;
  readonly sourceEntryId: string | null;
  readonly dependentEntryId: string;
  readonly servingsDrawn: number;
  readonly note: string | null;
}

export async function loadPrepLinks(
  ctx: ServiceContext,
  entryIds: readonly string[],
): Promise<PrepLinkView[]> {
  if (entryIds.length === 0) return [];

  return inScope(ctx, async ({ tx }) => {
    const rows = await tx
      .select()
      .from(prepLink)
      .where(
        and(
          eq(prepLink.userId, ctx.userId),
          inArray(prepLink.dependentEntryId, [...entryIds]),
        ),
      );
    return rows.map(toView);
  });
}

export interface LinkPrepResult {
  readonly link: PrepLinkView;
  readonly warnings: DomainWarning[];
}

/**
 * The user's door: both entries are looked up in the active week.
 *
 * `prepLinkInputSchema` validates rather than a hand-written TypeScript type.
 * A `servingsDrawn` of 0 used to reach the `prep_link_servings_positive` check
 * as a raw `23514`, and the note was unbounded where the published schema caps
 * it at 500 characters.
 */
export async function linkPrep(
  ctx: ServiceContext,
  week: unknown,
  input: unknown,
): Promise<LinkPrepResult> {
  const isoWeek = isoWeekSchema.parse(week);
  const parsed = prepLinkInputSchema.parse(input);

  return inScope(ctx, async (scoped) => {
    const view = await getWeekView(scoped, isoWeek);
    // The slots the week view has already loaded, rather than a second read of
    // the same grid.
    const endpoints = await buildEndpoints(scoped, view.entries, view.slots);
    return applyLink(scoped, isoWeek, endpoints, parsed, "active");
  });
}

/**
 * The proposal's door: the entries are the ones the write just produced.
 *
 * `entries` is trusted as the week rather than re-read, which is the whole
 * point: they may be `pending`, and a pending version is by definition not the
 * active week. Ownership is not taken on trust, though: the ids go into the
 * same `prep_link` insert, whose composite foreign key ties the dependent entry
 * to this user's, and every row `mutateWeek` returns was written under this
 * user's scope in this transaction.
 */
export async function linkPrepInVersion(
  ctx: ScopedContext,
  isoWeek: IsoWeek,
  entries: readonly PlanEntryView[],
  input: PrepLinkInput,
): Promise<{ warnings: DomainWarning[] }> {
  const slots = await loadSlotDefinitions(ctx);
  const endpoints = await buildEndpoints(ctx, entries, slots);
  const { warnings } = await applyLink(
    ctx,
    isoWeek,
    endpoints,
    input,
    "version",
  );
  return { warnings };
}

/**
 * The rules and the write, once.
 *
 * `scope` only changes the sentence a missing endpoint produces, because the
 * two callers mean different things by "not in this week" and an agent has to
 * be able to tell them apart.
 */
async function applyLink(
  ctx: ScopedContext,
  isoWeek: IsoWeek,
  endpoints: Map<string, PrepEndpoint>,
  input: PrepLinkInput,
  scope: "active" | "version",
): Promise<LinkPrepResult> {
  const source = endpoints.get(input.sourceEntryId);
  const dependent = endpoints.get(input.dependentEntryId);

  if (!source || !dependent) {
    throw new DomainError(
      "NOT_FOUND",
      scope === "active"
        ? `La session de cuisine et le repas qui en dépend doivent tous deux appartenir à la version active de la semaine ${formatIsoWeek(isoWeek)}.`
        : `La session de cuisine et le repas qui en dépend doivent tous deux figurer parmi les repas de cet appel, pour la semaine ${formatIsoWeek(isoWeek)}.`,
      {
        sourceEntryId: input.sourceEntryId,
        dependentEntryId: input.dependentEntryId,
        available: [...endpoints.keys()],
      },
    );
  }

  // Hard rule: you cannot eat on Tuesday what you cook on Thursday.
  assertPrepOrder(source, dependent);

  const servingsDrawn = input.servingsDrawn ?? dependent.servings;

  const rows = await ctx.tx
    .insert(prepLink)
    .values({
      userId: ctx.userId,
      sourceEntryId: source.entryId,
      dependentEntryId: dependent.entryId,
      servingsDrawn,
      note: input.note,
    })
    .onConflictDoUpdate({
      target: prepLink.dependentEntryId,
      set: {
        sourceEntryId: source.entryId,
        servingsDrawn,
        note: input.note,
      },
    })
    .returning();

  const warnings: DomainWarning[] = [];
  const batch = checkBatchFriendly(source);
  if (batch) warnings.push(batch);

  // `checkPrepCapacity` used to be called here. It now always returns null,
  // because the warning it produced was false on every prep link there has
  // ever been: it compared the draws against a servings figure that excludes
  // them, and the grocery service already scales the source to cover them. The
  // call is gone rather than kept as a no-op, and the domain function stays as
  // the place a real capacity model would land. See src/domain/prep.ts.

  return { link: toView(firstRow(rows, "prep link upsert")), warnings };
}

/**
 * Clears the cooking session behind a meal.
 *
 * It throws when there was no link, like every other delete in the service
 * layer: a silent no-op leaves the caller unable to tell a success from a miss,
 * and the screen showing "unlinked" for an id that never had a link is the
 * visible half of that.
 */
export async function unlinkPrep(
  ctx: ServiceContext,
  dependentEntryId: string,
): Promise<void> {
  await inScope(ctx, async ({ tx }) => {
    const rows = await tx
      .delete(prepLink)
      .where(
        and(
          eq(prepLink.userId, ctx.userId),
          eq(prepLink.dependentEntryId, dependentEntryId),
        ),
      )
      .returning({ id: prepLink.id });
    if (!rows[0]) {
      throw new DomainError(
        "NOT_FOUND",
        "Ce repas n'est pas rattaché à une session de cuisine.",
        { dependentEntryId },
      );
    }
  });
}

/** Dependent meals whose cooking session was cleared. Drives the banner. */
export async function unsourcedLinks(
  ctx: ServiceContext,
): Promise<PrepLinkView[]> {
  return inScope(ctx, async ({ tx }) => {
    const rows = await tx
      .select()
      .from(prepLink)
      .where(
        and(eq(prepLink.userId, ctx.userId), isNull(prepLink.sourceEntryId)),
      );
    return rows.map(toView);
  });
}

/**
 * Everything the prep rules need about a set of entries, in one read.
 *
 * The slots are passed in rather than loaded, because both callers already have
 * them: this used to call `getWeekView`, which loads the grid, and then load
 * the grid again.
 */
async function buildEndpoints(
  ctx: ScopedContext,
  entries: readonly PlanEntryView[],
  slots: readonly SlotDefinition[],
): Promise<Map<string, PrepEndpoint>> {
  const summaries = await loadRecipeSummaries(
    ctx,
    entries
      .map((entry) => entry.recipeId)
      .filter((id): id is string => id !== null),
  );

  const endpoints = new Map<string, PrepEndpoint>();
  for (const entry of entries) {
    const slot = slots.find(
      (candidate) =>
        candidate.dayOfWeek === entry.dayOfWeek &&
        candidate.mealTypeId === entry.mealTypeId,
    );
    endpoints.set(entry.id, {
      entryId: entry.id,
      dayOfWeek: entry.dayOfWeek,
      mealTypeLabel: slot?.mealTypeLabel ?? "",
      recipeTitle: entry.recipeTitleSnapshot,
      servings: entry.servings,
      batchFriendly:
        entry.recipeId !== null
          ? (summaries.get(entry.recipeId)?.batchFriendly ?? false)
          : false,
    });
  }

  return endpoints;
}

function toView(row: typeof prepLink.$inferSelect): PrepLinkView {
  return {
    id: row.id,
    sourceEntryId: row.sourceEntryId,
    dependentEntryId: row.dependentEntryId,
    servingsDrawn: row.servingsDrawn,
    note: row.note,
  };
}
