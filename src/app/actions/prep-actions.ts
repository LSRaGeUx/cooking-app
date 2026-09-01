"use server";

import { revalidatePath } from "next/cache";
import { formatIsoWeek, type IsoWeek } from "@/domain/week";
import { requireUser } from "@/lib/session";
import { linkPrep, unlinkPrep, type LinkPrepResult } from "@/services/prep-service";
import { runAction, type ActionResult } from "./result";

function revalidateWeek(week: IsoWeek): void {
  revalidatePath(`/semaine/${formatIsoWeek(week)}`);
  revalidatePath(`/courses/${formatIsoWeek(week)}`);
}

export async function linkPrepAction(
  week: IsoWeek,
  sourceEntryId: string,
  dependentEntryId: string,
): Promise<ActionResult<LinkPrepResult>> {
  const { ctx } = await requireUser();
  const result = await runAction(() =>
    linkPrep(ctx, week, { sourceEntryId, dependentEntryId }),
  );
  if (result.ok) revalidateWeek(week);
  return result;
}

export async function unlinkPrepAction(
  week: IsoWeek,
  dependentEntryId: string,
): Promise<ActionResult<void>> {
  const { ctx } = await requireUser();
  const result = await runAction(() => unlinkPrep(ctx, dependentEntryId));
  if (result.ok) revalidateWeek(week);
  return result;
}
