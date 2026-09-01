"use server";

import { revalidatePath } from "next/cache";
import { formatIsoWeek, type IsoWeek } from "@/domain/week";
import { requireUser } from "@/lib/session";
import {
  acceptPendingEntries,
  acceptPendingVersion,
  rejectPendingVersion,
  type PlanVersionView,
  type WriteResult,
} from "@/services/plan-service";
import { runAction, type ActionResult } from "./result";

function revalidateWeek(week: IsoWeek): void {
  revalidatePath(`/semaine/${formatIsoWeek(week)}`);
  revalidatePath(`/semaine/${formatIsoWeek(week)}/proposition`);
}

export async function acceptProposalAction(
  week: IsoWeek,
): Promise<ActionResult<WriteResult>> {
  const { ctx } = await requireUser();
  const result = await runAction(() => acceptPendingVersion(ctx, week));
  if (result.ok) revalidateWeek(week);
  return result;
}

export async function acceptProposalEntriesAction(
  week: IsoWeek,
  entryIds: string[],
): Promise<ActionResult<WriteResult>> {
  const { ctx } = await requireUser();
  const result = await runAction(() =>
    acceptPendingEntries(ctx, week, entryIds),
  );
  if (result.ok) revalidateWeek(week);
  return result;
}

/**
 * The reason is captured rather than optional-in-practice, because it is the
 * highest quality signal the product ever receives: the user saying, in their
 * own words, what was wrong with a personalized suggestion.
 */
export async function rejectProposalAction(
  week: IsoWeek,
  reason: string | null,
): Promise<ActionResult<PlanVersionView>> {
  const { ctx } = await requireUser();
  const result = await runAction(() => rejectPendingVersion(ctx, week, reason));
  if (result.ok) revalidateWeek(week);
  return result;
}
