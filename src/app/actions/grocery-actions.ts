"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import {
  addManualLine,
  archiveGroceryList,
  deleteLine,
  generateGroceryList,
  setLineChecked,
  type GenerateResult,
  type GroceryLineView,
  type ManualLineInput,
} from "@/services/grocery-service";
import { runAction, type ActionResult } from "./result";

/** `cycleStart` is the `yyyy-mm-dd` the shopping cycle begins on. */
function revalidateList(cycleStart: string): void {
  revalidatePath(`/courses/${cycleStart}`);
}

export async function generateGroceryListAction(
  cycleStart: string,
): Promise<ActionResult<GenerateResult>> {
  const { ctx } = await requireUser();
  const result = await runAction(() => generateGroceryList(ctx, cycleStart));
  if (result.ok) revalidateList(cycleStart);
  return result;
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
  return runAction(() => setLineChecked(ctx, lineId, checked));
}

export async function addManualLineAction(
  cycleStart: string,
  listId: string,
  input: ManualLineInput,
): Promise<ActionResult<GroceryLineView>> {
  const { ctx } = await requireUser();
  const result = await runAction(() => addManualLine(ctx, listId, input));
  if (result.ok) revalidateList(cycleStart);
  return result;
}

export async function deleteLineAction(
  cycleStart: string,
  lineId: string,
): Promise<ActionResult<void>> {
  const { ctx } = await requireUser();
  const result = await runAction(() => deleteLine(ctx, lineId));
  if (result.ok) revalidateList(cycleStart);
  return result;
}

export async function archiveGroceryListAction(
  cycleStart: string,
  listId: string,
): Promise<ActionResult<void>> {
  const { ctx } = await requireUser();
  const result = await runAction(() => archiveGroceryList(ctx, listId));
  if (result.ok) revalidateList(cycleStart);
  return result;
}
