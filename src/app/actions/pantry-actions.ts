"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { pantryItemInputSchema } from "@/domain/schemas";
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

const itemIdSchema = z.uuid();
/** One typed row at a time from the screen; the cap is for an agent's batch. */
const itemsSchema = z.array(pantryItemInputSchema).min(1).max(100);

export async function addPantryItemsAction(
  items: readonly unknown[],
): Promise<ActionResult<PantryItemView[]>> {
  const { ctx } = await requireUser();
  return runAction(async () => {
    const saved = await addPantryItems(ctx, itemsSchema.parse(items));
    revalidatePantry();
    return saved;
  });
}

export async function removePantryItemAction(
  itemId: string,
): Promise<ActionResult<void>> {
  const { ctx } = await requireUser();
  return runAction(async () => {
    await removePantryItem(ctx, itemIdSchema.parse(itemId));
    revalidatePantry();
  });
}
