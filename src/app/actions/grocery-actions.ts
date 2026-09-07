"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { manualLineInputSchema } from "@/domain/schemas";
import { parseCycleStart } from "@/domain/shopping";
import { requireUser } from "@/lib/session";
import {
  addManualLine,
  archiveGroceryList,
  deleteLine,
  generateGroceryList,
  setLineChecked,
  type GenerateResult,
  type GroceryLineView,
} from "@/services/grocery-service";
import { runAction, type ActionResult } from "./result";

/**
 * A cycle start is the identity of a grocery list and goes straight into a
 * revalidation path, so it is checked to be a real date rather than trusted to
 * look like one. `parseCycleStart` refuses 2026-02-30 as well as gibberish.
 */
const cycleStartSchema = z
  .string()
  .refine((value) => parseCycleStart(value) !== null);

const listIdSchema = z.uuid();
const lineIdSchema = z.uuid();

/** `cycleStart` is the `yyyy-mm-dd` the shopping cycle begins on. */
function revalidateList(cycleStart: string): void {
  revalidatePath(`/courses/${cycleStart}`);
}

export async function generateGroceryListAction(
  cycleStart: string,
): Promise<ActionResult<GenerateResult>> {
  const { ctx } = await requireUser();
  return runAction(async () => {
    const cycle = cycleStartSchema.parse(cycleStart);
    const result = await generateGroceryList(ctx, cycle);
    revalidateList(cycle);
    return result;
  });
}

/**
 * Deliberately does not revalidate. Ticking a line happens one-handed in a shop
 * on a bad connection, and re-rendering the page under the user's thumb for
 * every checkbox is the wrong trade. The screen holds the state optimistically
 * and rolls back if this fails.
 */
export async function setLineCheckedAction(
  lineId: string,
  checked: boolean,
): Promise<ActionResult<void>> {
  const { ctx } = await requireUser();
  return runAction(() =>
    setLineChecked(ctx, lineIdSchema.parse(lineId), z.boolean().parse(checked)),
  );
}

export async function addManualLineAction(
  cycleStart: string,
  listId: string,
  input: unknown,
): Promise<ActionResult<GroceryLineView>> {
  const { ctx } = await requireUser();
  return runAction(async () => {
    const cycle = cycleStartSchema.parse(cycleStart);
    const line = await addManualLine(
      ctx,
      listIdSchema.parse(listId),
      manualLineInputSchema.parse(input),
    );
    revalidateList(cycle);
    return line;
  });
}

export async function deleteLineAction(
  cycleStart: string,
  lineId: string,
): Promise<ActionResult<void>> {
  const { ctx } = await requireUser();
  return runAction(async () => {
    const cycle = cycleStartSchema.parse(cycleStart);
    await deleteLine(ctx, lineIdSchema.parse(lineId));
    revalidateList(cycle);
  });
}

export async function archiveGroceryListAction(
  cycleStart: string,
  listId: string,
): Promise<ActionResult<void>> {
  const { ctx } = await requireUser();
  return runAction(async () => {
    const cycle = cycleStartSchema.parse(cycleStart);
    await archiveGroceryList(ctx, listIdSchema.parse(listId));
    revalidateList(cycle);
  });
}
