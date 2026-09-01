"use server";

import { revalidatePath } from "next/cache";
import { formatIsoWeek, type IsoWeek } from "@/domain/week";
import { requireUser } from "@/lib/session";
import {
  deleteFeedback,
  recordFeedback,
  type FeedbackView,
} from "@/services/feedback-service";
import { setSlotConfig } from "@/services/slot-service";
import { runAction, type ActionResult } from "./result";

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
  const result = await runAction(() => recordFeedback(ctx, entryId, input));
  if (result.ok) revalidateWeek(week);
  return result;
}

export async function clearFeedbackAction(
  week: IsoWeek,
  entryId: string,
): Promise<ActionResult<void>> {
  const { ctx } = await requireUser();
  const result = await runAction(() => deleteFeedback(ctx, entryId));
  if (result.ok) revalidateWeek(week);
  return result;
}

/**
 * Applying a suggested time budget is a click, never automatic. The app can see
 * that Saturday keeps running over; only the person living the Saturday can say
 * whether the answer is a bigger budget or a simpler dish.
 */
export async function applyBudgetSuggestionAction(
  dayOfWeek: number,
  mealTypeId: string,
  timeBudgetMin: number,
  defaultServings: number | null,
): Promise<ActionResult<unknown>> {
  const { ctx } = await requireUser();
  const result = await runAction(() =>
    setSlotConfig(ctx, {
      dayOfWeek,
      mealTypeId,
      state: "planned",
      timeBudgetMin,
      defaultServings,
    }),
  );
  if (result.ok) {
    revalidatePath("/creneaux");
    revalidatePath("/semaine", "layout");
  }
  return result;
}
