import { and, eq, inArray } from "drizzle-orm";
import { entryFeedback, planEntry } from "@/db/schema";
import { DomainError } from "@/domain/errors";
import { feedbackInputSchema, isoWeekSchema } from "@/domain/schemas";
import { isoWeekDate, type IsoDay, type IsoWeek } from "@/domain/week";
import { inScope, type ServiceContext } from "./context";
import { getWeekView } from "./plan-service";

/**
 * Recording what actually happened.
 *
 * Only the outcome is required. A prompt that demands a rating and a note is a
 * prompt people stop answering after two weeks, and the outcome alone already
 * carries the strongest signal: a meal planned and never cooked says more than
 * most ratings do.
 */

export interface FeedbackView {
  readonly id: string;
  readonly planEntryId: string;
  readonly outcome: string;
  readonly swappedFor: string | null;
  readonly rating: number | null;
  readonly note: string | null;
  readonly tookLonger: boolean;
  readonly portionIssue: string | null;
  readonly createdAt: Date;
}

export async function recordFeedback(
  ctx: ServiceContext,
  entryId: string,
  input: unknown,
): Promise<FeedbackView> {
  const parsed = feedbackInputSchema.parse(input);

  return inScope(ctx, async (tx) => {
    const owned = await tx
      .select({ id: planEntry.id })
      .from(planEntry)
      .where(and(eq(planEntry.id, entryId), eq(planEntry.userId, ctx.userId)))
      .limit(1);
    if (!owned[0]) {
      throw new DomainError(
        "NOT_FOUND",
        "Ce repas n'existe pas dans vos plans.",
        { entryId },
      );
    }

    // One verdict per meal: recording again corrects the previous answer
    // instead of stacking a second one.
    const rows = await tx
      .insert(entryFeedback)
      .values({
        userId: ctx.userId,
        planEntryId: entryId,
        outcome: parsed.outcome,
        swappedFor: parsed.swappedFor,
        rating: parsed.rating,
        note: parsed.note,
        tookLonger: parsed.tookLonger,
        portionIssue: parsed.portionIssue,
      })
      .onConflictDoUpdate({
        target: entryFeedback.planEntryId,
        set: {
          outcome: parsed.outcome,
          swappedFor: parsed.swappedFor,
          rating: parsed.rating,
          note: parsed.note,
          tookLonger: parsed.tookLonger,
          portionIssue: parsed.portionIssue,
        },
      })
      .returning();

    return toView(rows[0]!);
  });
}

export async function deleteFeedback(
  ctx: ServiceContext,
  entryId: string,
): Promise<void> {
  await inScope(ctx, async (tx) => {
    await tx
      .delete(entryFeedback)
      .where(eq(entryFeedback.planEntryId, entryId));
  });
}

export async function loadFeedbackForEntries(
  ctx: ServiceContext,
  entryIds: readonly string[],
): Promise<Map<string, FeedbackView>> {
  if (entryIds.length === 0) return new Map();

  return inScope(ctx, async (tx) => {
    const rows = await tx
      .select()
      .from(entryFeedback)
      .where(inArray(entryFeedback.planEntryId, [...entryIds]));
    return new Map(rows.map((row) => [row.planEntryId, toView(row)]));
  });
}

export interface PendingFeedbackEntry {
  readonly entryId: string;
  readonly dayOfWeek: number;
  readonly mealTypeId: string;
  readonly mealTypeLabel: string;
  readonly recipeTitle: string;
  readonly date: Date;
}

/**
 * Meals whose day has passed and that nobody has judged yet.
 *
 * The date check is what keeps the prompt honest: asking on Monday morning
 * whether Monday dinner went well is how a product teaches people to ignore it.
 */
export async function pendingFeedback(
  ctx: ServiceContext,
  week: unknown,
  now: Date = new Date(),
): Promise<PendingFeedbackEntry[]> {
  const isoWeek = isoWeekSchema.parse(week);

  return inScope(ctx, async (tx) => {
    const scoped = { ...ctx, tx };
    const view = await getWeekView(scoped, isoWeek);
    const recorded = await loadFeedbackForEntries(
      scoped,
      view.entries.map((entry) => entry.id),
    );

    const pending: PendingFeedbackEntry[] = [];
    for (const entry of view.entries) {
      if (recorded.has(entry.id)) continue;
      const date = isoWeekDate(isoWeek as IsoWeek, entry.dayOfWeek as IsoDay);
      // A day is over once the next one has begun, in the user's own calendar.
      if (endOfDay(date).getTime() > now.getTime()) continue;

      const slot = view.slots.find(
        (candidate) =>
          candidate.dayOfWeek === entry.dayOfWeek &&
          candidate.mealTypeId === entry.mealTypeId,
      );

      pending.push({
        entryId: entry.id,
        dayOfWeek: entry.dayOfWeek,
        mealTypeId: entry.mealTypeId,
        mealTypeLabel: slot?.mealTypeLabel ?? "",
        recipeTitle: entry.recipeTitleSnapshot,
        date,
      });
    }

    return pending;
  });
}

function endOfDay(date: Date): Date {
  const end = new Date(date);
  end.setUTCHours(23, 59, 59, 999);
  return end;
}

function toView(row: typeof entryFeedback.$inferSelect): FeedbackView {
  return {
    id: row.id,
    planEntryId: row.planEntryId,
    outcome: row.outcome,
    swappedFor: row.swappedFor,
    rating: row.rating,
    note: row.note,
    tookLonger: row.tookLonger,
    portionIssue: row.portionIssue,
    createdAt: row.createdAt,
  };
}
