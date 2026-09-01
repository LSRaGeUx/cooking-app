"use server";

import { revalidatePath } from "next/cache";
import { formatIsoWeek, type IsoWeek } from "@/domain/week";
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

function revalidateList(week: IsoWeek): void {
  revalidatePath(`/courses/${formatIsoWeek(week)}`);
}

export async function generateGroceryListAction(
  week: IsoWeek,
): Promise<ActionResult<GenerateResult>> {
  const { ctx } = await requireUser();
  const result = await runAction(() => generateGroceryList(ctx, week));
  if (result.ok) revalidateList(week);
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
  week: IsoWeek,
  listId: string,
  input: ManualLineInput,
): Promise<ActionResult<GroceryLineView>> {
  const { ctx } = await requireUser();
  const result = await runAction(() => addManualLine(ctx, listId, input));
  if (result.ok) revalidateList(week);
  return result;
}

export async function deleteLineAction(
  week: IsoWeek,
  lineId: string,
): Promise<ActionResult<void>> {
  const { ctx } = await requireUser();
  const result = await runAction(() => deleteLine(ctx, lineId));
  if (result.ok) revalidateList(week);
  return result;
}

export async function archiveGroceryListAction(
  week: IsoWeek,
  listId: string,
): Promise<ActionResult<void>> {
  const { ctx } = await requireUser();
  const result = await runAction(() => archiveGroceryList(ctx, listId));
  if (result.ok) revalidateList(week);
  return result;
}
