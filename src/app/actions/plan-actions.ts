"use server";

import { revalidatePath } from "next/cache";
import { formatIsoWeek, type IsoWeek } from "@/domain/week";
import { requireUser } from "@/lib/session";
import {
  assignRecipe,
  clearEntry,
  duplicateEntry,
  moveEntry,
  revertToVersion,
  updateEntry,
  type WriteResult,
} from "@/services/plan-service";
import { runAction, type ActionResult } from "./result";

/**
 * The web UI's write path into planning. Every one of these is a thin adapter:
 * authenticate, call the service, revalidate. No rule lives here, because the
 * MCP endpoint calls the same services and a rule written here would apply to
 * only one of the two callers.
 */

function revalidateWeek(week: IsoWeek): void {
  revalidatePath(`/semaine/${formatIsoWeek(week)}`);
}

export async function assignRecipeAction(
  week: IsoWeek,
  input: {
    dayOfWeek: number;
    mealTypeId: string;
    recipeId: string;
    servings?: number | null;
    note?: string | null;
    position?: number;
  },
): Promise<ActionResult<WriteResult>> {
  const { ctx } = await requireUser();
  const result = await runAction(() => assignRecipe(ctx, week, input));
  if (result.ok) revalidateWeek(week);
  return result;
}

export async function clearEntryAction(
  week: IsoWeek,
  entryId: string,
): Promise<ActionResult<WriteResult>> {
  const { ctx } = await requireUser();
  const result = await runAction(() => clearEntry(ctx, week, entryId));
  if (result.ok) revalidateWeek(week);
  return result;
}

export async function moveEntryAction(
  week: IsoWeek,
  entryId: string,
  target: { dayOfWeek: number; mealTypeId: string },
): Promise<ActionResult<WriteResult>> {
  const { ctx } = await requireUser();
  const result = await runAction(() => moveEntry(ctx, week, entryId, target));
  if (result.ok) revalidateWeek(week);
  return result;
}

export async function duplicateEntryAction(
  week: IsoWeek,
  entryId: string,
  target: { dayOfWeek: number; mealTypeId: string },
): Promise<ActionResult<WriteResult>> {
  const { ctx } = await requireUser();
  const result = await runAction(() =>
    duplicateEntry(ctx, week, entryId, target),
  );
  if (result.ok) revalidateWeek(week);
  return result;
}

export async function updateEntryAction(
  week: IsoWeek,
  entryId: string,
  changes: { servings?: number; note?: string | null },
): Promise<ActionResult<WriteResult>> {
  const { ctx } = await requireUser();
  const result = await runAction(() =>
    updateEntry(ctx, week, entryId, changes),
  );
  if (result.ok) revalidateWeek(week);
  return result;
}

export async function revertToVersionAction(
  week: IsoWeek,
  versionNumber: number,
): Promise<ActionResult<WriteResult>> {
  const { ctx } = await requireUser();
  const result = await runAction(() =>
    revertToVersion(ctx, week, versionNumber),
  );
  if (result.ok) revalidateWeek(week);
  return result;
}
