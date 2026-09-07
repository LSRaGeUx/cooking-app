"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  feedbackInputSchema,
  isoWeekSchema,
  slotRefSchema,
} from "@/domain/schemas";
import { formatIsoWeek, type IsoWeek } from "@/domain/week";
import { requireUser } from "@/lib/session";
import {
  deleteFeedback,
  recordFeedback,
  type FeedbackView,
} from "@/services/feedback-service";
import {
  patchSlotTimeBudget,
  type SlotConfigView,
} from "@/services/slot-service";
import { runAction, type ActionResult } from "./result";

/**
 * Every one of these parses its arguments before doing anything with them. A
 * server action is a public HTTP endpoint, so its TypeScript parameter types
 * are documentation and nothing more: they do not exist at runtime, and an
 * `IsoWeek` declared here arrives as whatever the request body carried.
 *
 * The parse happens inside `runAction` so a bad argument comes back as the
 * normal `VALIDATION` result the screen already renders, rather than as a 500.
 * Revalidation happens inside it too, after the service returns, so a refused
 * write cannot invalidate a page that did not change.
 */

const entryIdSchema = z.uuid();

function revalidateWeek(week: IsoWeek): void {
  revalidatePath(`/semaine/${formatIsoWeek(week)}`);
  revalidatePath(`/semaine/${formatIsoWeek(week)}/bilan`);
}

export async function recordFeedbackAction(
  week: IsoWeek,
  entryId: string,
  input: unknown,
): Promise<ActionResult<FeedbackView>> {
  const { ctx } = await requireUser();
  return runAction(async () => {
    const isoWeek = isoWeekSchema.parse(week);
    const view = await recordFeedback(
      ctx,
      entryIdSchema.parse(entryId),
      feedbackInputSchema.parse(input),
    );
    revalidateWeek(isoWeek);
    return view;
  });
}

export async function clearFeedbackAction(
  week: IsoWeek,
  entryId: string,
): Promise<ActionResult<void>> {
  const { ctx } = await requireUser();
  return runAction(async () => {
    const isoWeek = isoWeekSchema.parse(week);
    await deleteFeedback(ctx, entryIdSchema.parse(entryId));
    revalidateWeek(isoWeek);
  });
}

/**
 * Applying a suggested time budget is a click, never automatic. The app can see
 * that Saturday keeps running over; only the person living the Saturday can say
 * whether the answer is a bigger budget or a simpler dish.
 *
 * It patches the budget and nothing else. This used to rebuild the whole slot
 * configuration through `setSlotConfig`, forcing `state: "planned"` and writing
 * `defaultServings` straight from the client, which the feedback screen passed
 * as null. So accepting a suggestion wiped the slot's default servings and
 * could un-skip a slot the user had deliberately skipped. Which columns a
 * suggestion may touch is a rule, and a rule does not live in an action
 * (CLAUDE.md rule 3), so it lives in `patchSlotTimeBudget`.
 */
export async function applyBudgetSuggestionAction(
  ref: { dayOfWeek: number; mealTypeId: string },
  timeBudgetMin: number,
): Promise<ActionResult<SlotConfigView>> {
  const { ctx } = await requireUser();
  return runAction(async () => {
    const slot = await patchSlotTimeBudget(
      ctx,
      slotRefSchema.parse(ref),
      timeBudgetSchema.parse(timeBudgetMin),
    );
    revalidatePath("/creneaux");
    /*
     * A route pattern plus a type, because the week screens are dynamic and
     * the budget applies to every week, not to one of them. This used to say
     * `revalidatePath("/semaine", "layout")`, and "/semaine" is a segment with
     * neither a page nor a layout of its own, so it matched no cache entry at
     * all and both screens stayed stale.
     */
    revalidatePath("/semaine/[week]", "page");
    revalidatePath("/semaine/[week]/bilan", "page");
    return slot;
  });
}

/** The same bounds `slotConfigInputSchema` puts on the column. */
const timeBudgetSchema = z.number().int().min(0).max(600);
