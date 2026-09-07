"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { mealTypeInputSchema, slotConfigInputSchema } from "@/domain/schemas";
import { requireUser } from "@/lib/session";
import {
  createMealType,
  deleteMealType,
  renameMealType,
  setSlotConfig,
} from "@/services/slot-service";
import { runAction } from "./result";

const mealTypeIdSchema = z.uuid();

/**
 * None of these declares `ActionResult<unknown>` any more. The service return
 * types flow through `runAction`, so the slot editor reads the saved row
 * instead of redeclaring a loose shape for it.
 *
 * `setSlotConfigsAction` used to sit here as well, wrapping the batch service.
 * Nothing ever called it: the editor writes one cell per click, which is the
 * whole design of the screen, and there is no UI that saves a whole grid at
 * once. It has been removed rather than kept as a second entry point nobody
 * exercises. `setSlotConfigs` stays in the service, where the MCP surface can
 * reach it.
 */

export async function setSlotConfigAction(input: unknown) {
  const { ctx } = await requireUser();
  return runAction(async () => {
    const saved = await setSlotConfig(ctx, slotConfigInputSchema.parse(input));
    revalidateSlotScreens();
    return saved;
  });
}

export async function createMealTypeAction(input: unknown) {
  const { ctx } = await requireUser();
  return runAction(async () => {
    const saved = await createMealType(ctx, mealTypeInputSchema.parse(input));
    revalidateSlotScreens();
    return saved;
  });
}

export async function renameMealTypeAction(mealTypeId: string, label: unknown) {
  const { ctx } = await requireUser();
  return runAction(async () => {
    const { label: parsed } = mealTypeInputSchema
      .pick({ label: true })
      .parse({ label });
    const saved = await renameMealType(
      ctx,
      mealTypeIdSchema.parse(mealTypeId),
      parsed,
    );
    revalidateSlotScreens();
    return saved;
  });
}

export async function deleteMealTypeAction(mealTypeId: string) {
  const { ctx } = await requireUser();
  return runAction(async () => {
    await deleteMealType(ctx, mealTypeIdSchema.parse(mealTypeId));
    revalidateSlotScreens();
  });
}

/**
 * Slot configuration changes what the week screens render but never what an
 * existing plan version contains, so the screens are revalidated and no plan is
 * touched.
 *
 * The week screens are dynamic routes, so each is named by its route pattern
 * with an explicit type. This used to say `revalidatePath("/semaine",
 * "layout")`: "/semaine" is a segment with neither a page nor a layout of its
 * own, so it matched no cache entry, nothing was invalidated, and a renamed
 * meal type kept its old label on the week screen until something else
 * happened to revalidate it.
 */
function revalidateSlotScreens(): void {
  revalidatePath("/creneaux");
  revalidatePath("/semaine/[week]", "page");
  revalidatePath("/semaine/[week]/bilan", "page");
  revalidatePath("/semaine/[week]/proposition", "page");
}
