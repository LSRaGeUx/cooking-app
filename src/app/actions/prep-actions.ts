"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { isoWeekSchema, prepLinkInputSchema } from "@/domain/schemas";
import { formatIsoWeek, type IsoWeek } from "@/domain/week";
import { requireUser } from "@/lib/session";
import {
  linkPrep,
  unlinkPrep,
  type LinkPrepResult,
} from "@/services/prep-service";
import { runAction, type ActionResult } from "./result";

const entryIdSchema = z.uuid();

/**
 * A prep link changes two things: which meal the week screen draws as reheated,
 * and which ingredients the grocery list buys once instead of twice.
 *
 * The grocery screen is `/courses/[cycle]`, keyed by the date a shopping cycle
 * starts on and not by an ISO week: a cycle can straddle a Sunday, which is the
 * whole point of it (docs/01-functional-spec.md section 8.1). This used to
 * revalidate `/courses/2026-W37`, a path no route ever produces, so the
 * shopping list kept showing ingredients a prep link had just merged away.
 *
 * Which cycle covers a given week depends on the profile's shopping day, so
 * rather than read the profile to compute one path, the route pattern is
 * invalidated: every grocery page re-reads on its next visit. That is correct
 * whichever cycle the week falls in, and a grocery page is cheap to rebuild.
 */
function revalidateWeek(week: IsoWeek): void {
  revalidatePath(`/semaine/${formatIsoWeek(week)}`);
  revalidatePath("/courses/[cycle]", "page");
}

export async function linkPrepAction(
  week: IsoWeek,
  sourceEntryId: string,
  dependentEntryId: string,
): Promise<ActionResult<LinkPrepResult>> {
  const { ctx } = await requireUser();
  return runAction(async () => {
    const isoWeek = isoWeekSchema.parse(week);
    const input = prepLinkInputSchema.parse({
      sourceEntryId,
      dependentEntryId,
    });
    // Only the two ids: the week screen links a session to a meal and never
    // sets a portion draw or a note, so the service's own defaults apply.
    const result = await linkPrep(ctx, isoWeek, {
      sourceEntryId: input.sourceEntryId,
      dependentEntryId: input.dependentEntryId,
    });
    revalidateWeek(isoWeek);
    return result;
  });
}

export async function unlinkPrepAction(
  week: IsoWeek,
  dependentEntryId: string,
): Promise<ActionResult<void>> {
  const { ctx } = await requireUser();
  return runAction(async () => {
    const isoWeek = isoWeekSchema.parse(week);
    await unlinkPrep(ctx, entryIdSchema.parse(dependentEntryId));
    revalidateWeek(isoWeek);
  });
}
