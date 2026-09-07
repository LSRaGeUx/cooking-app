"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { isoWeekSchema } from "@/domain/schemas";
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

/**
 * Accepting or refusing what an agent proposed. Both arguments are parsed
 * before use, for the same reason as everywhere else in this folder: the
 * parameter types are erased, and this is an HTTP endpoint an agent's own
 * client could reach.
 */

/** The cap matches `proposeWeekSchema`: a week has at most this many meals. */
const entryIdsSchema = z.array(z.uuid()).min(1).max(70);

/**
 * The reason is bounded here rather than trusted, because it reaches the
 * database as free text. 1000 characters is what `planEntryInputSchema` allows
 * a rationale, and this is the same kind of sentence in the other direction.
 */
const reasonSchema = z.string().max(1000).nullable();

function revalidateWeek(week: IsoWeek): void {
  revalidatePath(`/semaine/${formatIsoWeek(week)}`);
  revalidatePath(`/semaine/${formatIsoWeek(week)}/proposition`);
}

export async function acceptProposalAction(
  week: IsoWeek,
): Promise<ActionResult<WriteResult>> {
  const { ctx } = await requireUser();
  return runAction(async () => {
    const isoWeek = isoWeekSchema.parse(week);
    const result = await acceptPendingVersion(ctx, isoWeek);
    revalidateWeek(isoWeek);
    return result;
  });
}

export async function acceptProposalEntriesAction(
  week: IsoWeek,
  entryIds: readonly string[],
): Promise<ActionResult<WriteResult>> {
  const { ctx } = await requireUser();
  return runAction(async () => {
    const isoWeek = isoWeekSchema.parse(week);
    const result = await acceptPendingEntries(
      ctx,
      isoWeek,
      entryIdsSchema.parse(entryIds),
    );
    revalidateWeek(isoWeek);
    return result;
  });
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
  return runAction(async () => {
    const isoWeek = isoWeekSchema.parse(week);
    const result = await rejectPendingVersion(
      ctx,
      isoWeek,
      reasonSchema.parse(reason),
    );
    revalidateWeek(isoWeek);
    return result;
  });
}
