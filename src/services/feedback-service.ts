import { and, eq, inArray } from "drizzle-orm";
import { entryFeedback, plan, planEntry, planVersion } from "@/db/schema";
import { firstRow } from "@/db/rows";
import { DomainError } from "@/domain/errors";
import { feedbackInputSchema, isoWeekSchema } from "@/domain/schemas";
import { formatSlot } from "@/domain/slots";
import { isoWeekDate, utcFromLocalDate } from "@/domain/week";
import type { FeedbackOutcome, PortionIssue } from "@/domain/vocabulary";
import { inScope, type ScopedContext, type ServiceContext } from "./context";
import { getWeekView } from "./plan-queries";

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
  readonly outcome: FeedbackOutcome;
  readonly swappedFor: string | null;
  readonly rating: number | null;
  readonly note: string | null;
  readonly tookLonger: boolean;
  readonly portionIssue: PortionIssue | null;
  readonly createdAt: Date;
}

/**
 * Records a verdict on one planned meal.
 *
 * The entry has to belong to the **active** version of its week, not merely to
 * this user. Feedback attached to a superseded entry is invisible to every
 * aggregate in the product, because all of them filter `pv.state = 'active'`:
 * the row is written, the screen shows it saved, and the history, the recipe
 * index and the signals never see it. Refusing is the honest answer, and the
 * message says where the verdict belongs instead.
 */
export async function recordFeedback(
  ctx: ServiceContext,
  entryId: string,
  input: unknown,
): Promise<FeedbackView> {
  const parsed = feedbackInputSchema.parse(input);

  return inScope(ctx, async (scoped) => {
    await requireActiveEntry(scoped, entryId);

    // One verdict per meal: recording again corrects the previous answer
    // instead of stacking a second one.
    const rows = await scoped.tx
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

    return toView(firstRow(rows, "feedback upsert"));
  });
}

/**
 * Deleting a verdict, which only a person may do.
 *
 * It removes user-typed data outright, and it is the one write in this file an
 * agent has no business making: a rating the user gave is not an agent's to
 * withdraw. Nothing but the absence of an MCP tool was stopping it, and rule 3
 * says a rule that lives only in the tool list is not enforced.
 */
export async function deleteFeedback(
  ctx: ServiceContext,
  entryId: string,
): Promise<void> {
  if (ctx.actor !== "user") {
    throw new DomainError(
      "FORBIDDEN",
      "Un agent ne peut pas supprimer un retour. C'est le jugement de la personne sur un repas qu'elle a mangé, et il n'appartient qu'à elle. Enregistrez un nouveau retour si le vôtre est plus juste.",
      { entryId },
    );
  }

  await inScope(ctx, async ({ tx }) => {
    const rows = await tx
      .delete(entryFeedback)
      .where(
        and(
          eq(entryFeedback.planEntryId, entryId),
          eq(entryFeedback.userId, ctx.userId),
        ),
      )
      .returning({ id: entryFeedback.id });
    if (!rows[0]) {
      throw new DomainError(
        "NOT_FOUND",
        "Aucun retour enregistré pour ce repas.",
        { entryId },
      );
    }
  });
}

export async function loadFeedbackForEntries(
  ctx: ServiceContext,
  entryIds: readonly string[],
): Promise<Map<string, FeedbackView>> {
  if (entryIds.length === 0) return new Map();

  return inScope(ctx, async ({ tx }) => {
    const rows = await tx
      .select()
      .from(entryFeedback)
      .where(
        and(
          eq(entryFeedback.userId, ctx.userId),
          inArray(entryFeedback.planEntryId, [...entryIds]),
        ),
      );
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
 *
 * A day is over once the next calendar day has begun, and the calendar is the
 * one `utcFromLocalDate` reads: the running instance's local day. That used to
 * be a UTC 23:59:59 comparison under a comment claiming it was "the user's own
 * calendar", which it was not, so a cook in Paris was prompted up to two hours
 * after their own midnight. Nothing in the model stores a timezone, so there is
 * no per-user calendar to compute in; a self-hosted instance runs in its cook's
 * zone, and that is now the one clock the whole file and src/domain/week.ts
 * agree on.
 */
export async function pendingFeedback(
  ctx: ServiceContext,
  week: unknown,
  now: Date = new Date(),
): Promise<PendingFeedbackEntry[]> {
  const isoWeek = isoWeekSchema.parse(week);

  // Today, as one calendar day at UTC midnight, which is the same form
  // `isoWeekDate` hands back so the two are directly comparable.
  const today = utcFromLocalDate(now);

  return inScope(ctx, async (scoped) => {
    const view = await getWeekView(scoped, isoWeek);
    const recorded = await loadFeedbackForEntries(
      scoped,
      view.entries.map((entry) => entry.id),
    );

    const pending: PendingFeedbackEntry[] = [];
    for (const entry of view.entries) {
      if (recorded.has(entry.id)) continue;
      // `isoWeek` is the parsed value and `entry.dayOfWeek` is narrowed by the
      // view, so neither needs a cast to reach `isoWeekDate` any more.
      const date = isoWeekDate(isoWeek, entry.dayOfWeek);
      if (today.getTime() <= date.getTime()) continue;

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

/**
 * The entry, if it is in the active version of its week.
 *
 * The error names the version the entry actually belongs to, because an agent
 * or a screen holding a stale entry id needs to know it is stale rather than
 * that "the meal does not exist".
 */
async function requireActiveEntry(
  ctx: ScopedContext,
  entryId: string,
): Promise<void> {
  const rows = await ctx.tx
    .select({
      state: planVersion.state,
      versionNumber: planVersion.versionNumber,
      isoYear: plan.isoYear,
      isoWeek: plan.isoWeek,
      dayOfWeek: planEntry.dayOfWeek,
      title: planEntry.recipeTitleSnapshot,
    })
    .from(planEntry)
    .innerJoin(planVersion, eq(planVersion.id, planEntry.planVersionId))
    .innerJoin(plan, eq(plan.id, planVersion.planId))
    .where(and(eq(planEntry.id, entryId), eq(planEntry.userId, ctx.userId)))
    .limit(1);

  const [found] = rows;
  if (!found) {
    throw new DomainError(
      "NOT_FOUND",
      "Ce repas n'existe pas dans vos plans.",
      {
        entryId,
      },
    );
  }

  if (found.state === "active") return;

  throw new DomainError(
    "NOT_FOUND",
    `Ce repas appartient à la version ${found.versionNumber} de la semaine ${found.isoYear}-W${String(found.isoWeek).padStart(2, "0")}, qui n'est plus la version active : la semaine a été modifiée depuis. Un retour enregistré là n'apparaîtrait dans aucun historique. Relisez la semaine et enregistrez le retour sur l'entrée correspondante de la version active.`,
    {
      entryId,
      versionState: found.state,
      versionNumber: found.versionNumber,
      year: found.isoYear,
      week: found.isoWeek,
      slot: formatSlot(found.dayOfWeek, found.title),
    },
  );
}

function toView(row: typeof entryFeedback.$inferSelect): FeedbackView {
  return {
    id: row.id,
    planEntryId: row.planEntryId,
    // `text` plus a check constraint in both cases, narrowed at this one
    // row-to-view boundary rather than by every reader.
    outcome: row.outcome as FeedbackOutcome,
    swappedFor: row.swappedFor,
    rating: row.rating,
    note: row.note,
    tookLonger: row.tookLonger,
    portionIssue: row.portionIssue as PortionIssue | null,
    createdAt: row.createdAt,
  };
}
