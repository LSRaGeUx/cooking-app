"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  isoWeekSchema,
  planEntryPatchSchema,
  slotRefSchema,
} from "@/domain/schemas";
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
 * authenticate, parse, call the service, revalidate. No rule lives here,
 * because the MCP endpoint calls the same services and a rule written here
 * would apply to only one of the two callers.
 *
 * The parse is not decoration. A server action is a public POST endpoint, and
 * the parameter types below are erased at build time, so without it the entry
 * id, the week and the patch body are whatever the request said they were. It
 * runs inside `runAction`, so a bad argument comes back as the `VALIDATION`
 * result every screen already knows how to render instead of a 500.
 */

const entryIdSchema = z.uuid();
const versionNumberSchema = z.number().int().min(1).max(100000);

/**
 * The week screen is `/semaine/[week]`, a dynamic route, but each of these
 * writes touches exactly one week, so the literal path is what to invalidate:
 * the docs are explicit that a literal path takes no `type` and a pattern
 * requires one.
 */
function revalidateWeek(week: IsoWeek): void {
  revalidatePath(`/semaine/${formatIsoWeek(week)}`);
}

export async function assignRecipeAction(
  week: IsoWeek,
  input: unknown,
): Promise<ActionResult<WriteResult>> {
  const { ctx } = await requireUser();
  return runAction(async () => {
    const isoWeek = isoWeekSchema.parse(week);
    const result = await assignRecipe(
      ctx,
      isoWeek,
      assignInputSchema.parse(input),
    );
    revalidateWeek(isoWeek);
    return result;
  });
}

export async function clearEntryAction(
  week: IsoWeek,
  entryId: string,
): Promise<ActionResult<WriteResult>> {
  const { ctx } = await requireUser();
  return runAction(async () => {
    const isoWeek = isoWeekSchema.parse(week);
    const result = await clearEntry(ctx, isoWeek, entryIdSchema.parse(entryId));
    revalidateWeek(isoWeek);
    return result;
  });
}

export async function moveEntryAction(
  week: IsoWeek,
  entryId: string,
  target: unknown,
): Promise<ActionResult<WriteResult>> {
  const { ctx } = await requireUser();
  return runAction(async () => {
    const isoWeek = isoWeekSchema.parse(week);
    const result = await moveEntry(
      ctx,
      isoWeek,
      entryIdSchema.parse(entryId),
      slotRefSchema.parse(target),
    );
    revalidateWeek(isoWeek);
    return result;
  });
}

export async function duplicateEntryAction(
  week: IsoWeek,
  entryId: string,
  target: unknown,
): Promise<ActionResult<WriteResult>> {
  const { ctx } = await requireUser();
  return runAction(async () => {
    const isoWeek = isoWeekSchema.parse(week);
    const result = await duplicateEntry(
      ctx,
      isoWeek,
      entryIdSchema.parse(entryId),
      slotRefSchema.parse(target),
    );
    revalidateWeek(isoWeek);
    return result;
  });
}

export async function updateEntryAction(
  week: IsoWeek,
  entryId: string,
  changes: unknown,
): Promise<ActionResult<WriteResult>> {
  const { ctx } = await requireUser();
  return runAction(async () => {
    const isoWeek = isoWeekSchema.parse(week);
    const result = await updateEntry(
      ctx,
      isoWeek,
      entryIdSchema.parse(entryId),
      planEntryPatchSchema.parse(changes),
    );
    revalidateWeek(isoWeek);
    return result;
  });
}

export async function revertToVersionAction(
  week: IsoWeek,
  versionNumber: number,
): Promise<ActionResult<WriteResult>> {
  const { ctx } = await requireUser();
  return runAction(async () => {
    const isoWeek = isoWeekSchema.parse(week);
    const result = await revertToVersion(
      ctx,
      isoWeek,
      versionNumberSchema.parse(versionNumber),
    );
    revalidateWeek(isoWeek);
    return result;
  });
}

/**
 * What the week screen sends when a recipe is dropped on a slot. It is the
 * planning entry shape minus the fields only an agent fills in: a person
 * editing their own week owes nobody a rationale.
 */
const assignInputSchema = slotRefSchema.extend({
  recipeId: z.uuid(),
  servings: z.number().int().min(1).max(50).nullable().optional(),
  note: z.string().max(500).nullable().optional(),
  position: z.number().int().min(0).max(10).optional(),
});
