import { and, eq, inArray, isNull } from "drizzle-orm";
import { prepLink } from "@/db/schema";
import { DomainError, type DomainWarning } from "@/domain/errors";
import {
  assertPrepOrder,
  checkBatchFriendly,
  checkPrepCapacity,
  type PrepEndpoint,
} from "@/domain/prep";
import { isoWeekSchema } from "@/domain/schemas";
import { inScope, type ServiceContext } from "./context";
import { getWeekView } from "./plan-service";
import { loadRecipeSummaries } from "./recipe-service";
import { loadSlotDefinitions } from "./slot-service";

/**
 * Prep links: which cooking session feeds which meal.
 *
 * The links live between plan entries, which belong to an immutable version, so
 * the planning service re-creates them when it copies a week forward. A source
 * that disappears leaves the link in place with no source rather than deleting
 * the dependent meal, which the user still intends to eat.
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

  return inScope(ctx, async (tx) => {
    const rows = await tx
      .select()
      .from(prepLink)
      .where(inArray(prepLink.dependentEntryId, [...entryIds]));
    return rows.map(toView);
  });
}

export interface LinkPrepResult {
  readonly link: PrepLinkView;
  readonly warnings: DomainWarning[];
}

export async function linkPrep(
  ctx: ServiceContext,
  week: unknown,
  input: {
    sourceEntryId: string;
    dependentEntryId: string;
    servingsDrawn?: number;
    note?: string | null;
  },
): Promise<LinkPrepResult> {
  const isoWeek = isoWeekSchema.parse(week);

  return inScope(ctx, async (tx) => {
    const scoped = { ...ctx, tx };
    const endpoints = await loadEndpoints(scoped, isoWeek);

    const source = endpoints.get(input.sourceEntryId);
    const dependent = endpoints.get(input.dependentEntryId);

    if (!source || !dependent) {
      throw new DomainError(
        "NOT_FOUND",
        "La session de cuisine et le repas qui en dépend doivent tous deux appartenir à la semaine active.",
        {
          sourceEntryId: input.sourceEntryId,
          dependentEntryId: input.dependentEntryId,
        },
      );
    }

    // Hard rule: you cannot eat on Tuesday what you cook on Thursday.
    assertPrepOrder(source, dependent);

    const servingsDrawn = input.servingsDrawn ?? dependent.servings;

    const rows = await tx
      .insert(prepLink)
      .values({
        userId: ctx.userId,
        sourceEntryId: source.entryId,
        dependentEntryId: dependent.entryId,
        servingsDrawn,
        note: input.note ?? null,
      })
      .onConflictDoUpdate({
        target: prepLink.dependentEntryId,
        set: {
          sourceEntryId: source.entryId,
          servingsDrawn,
          note: input.note ?? null,
        },
      })
      .returning();

    const existing = await tx
      .select()
      .from(prepLink)
      .where(eq(prepLink.sourceEntryId, source.entryId));

    const warnings: DomainWarning[] = [];
    const batch = checkBatchFriendly(source);
    if (batch) warnings.push(batch);

    const capacity = checkPrepCapacity(
      source,
      existing.flatMap((row) => {
        const target = endpoints.get(row.dependentEntryId);
        return target
          ? [{ dependent: target, servingsDrawn: row.servingsDrawn }]
          : [];
      }),
    );
    if (capacity) warnings.push(capacity);

    return { link: toView(rows[0]!), warnings };
  });
}

export async function unlinkPrep(
  ctx: ServiceContext,
  dependentEntryId: string,
): Promise<void> {
  await inScope(ctx, async (tx) => {
    await tx
      .delete(prepLink)
      .where(eq(prepLink.dependentEntryId, dependentEntryId));
  });
}

/** Dependent meals whose cooking session was cleared. Drives the banner. */
export async function unsourcedLinks(
  ctx: ServiceContext,
): Promise<PrepLinkView[]> {
  return inScope(ctx, async (tx) => {
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
 * Everything the prep rules need about the entries of a week, in one read.
 */
async function loadEndpoints(
  ctx: ServiceContext & { tx: NonNullable<ServiceContext["tx"]> },
  isoWeek: { year: number; week: number },
): Promise<Map<string, PrepEndpoint>> {
  const view = await getWeekView(ctx, isoWeek);
  const slots = await loadSlotDefinitions(ctx);
  const summaries = await loadRecipeSummaries(
    ctx,
    view.entries
      .map((entry) => entry.recipeId)
      .filter((id): id is string => id !== null),
  );

  const endpoints = new Map<string, PrepEndpoint>();
  for (const entry of view.entries) {
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
