"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import {
  addPantryItems,
  removePantryItem,
  type PantryItemView,
} from "@/services/pantry-service";
import { runAction, type ActionResult } from "./result";

/**
 * The pantry changes what a grocery list contains and what the snapshot says,
 * so both are revalidated. An existing list is not regenerated: it is a
 * snapshot the user may be shopping from, and rearranging it unasked is the one
 * thing that screen must not do.
 */
function revalidatePantry(): void {
  revalidatePath("/placards");
  revalidatePath("/profil/apercu");
}

export async function addPantryItemsAction(
  items: readonly unknown[],
): Promise<ActionResult<PantryItemView[]>> {
  const { ctx } = await requireUser();
  const result = await runAction(() => addPantryItems(ctx, items));
  if (result.ok) revalidatePantry();
  return result;
}

export async function removePantryItemAction(
  itemId: string,
): Promise<ActionResult<void>> {
  const { ctx } = await requireUser();
  const result = await runAction(() => removePantryItem(ctx, itemId));
  if (result.ok) revalidatePantry();
  return result;
}
