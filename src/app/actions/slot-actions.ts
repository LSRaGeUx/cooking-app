"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import {
  createMealType,
  deleteMealType,
  renameMealType,
  setSlotConfig,
  setSlotConfigs,
} from "@/services/slot-service";
import { runAction, type ActionResult } from "./result";

export async function setSlotConfigAction(
  input: unknown,
): Promise<ActionResult<unknown>> {
  const { ctx } = await requireUser();
  const result = await runAction(() => setSlotConfig(ctx, input));
  if (result.ok) revalidateSlotScreens();
  return result;
}

export async function setSlotConfigsAction(
  inputs: readonly unknown[],
): Promise<ActionResult<unknown>> {
  const { ctx } = await requireUser();
  const result = await runAction(() => setSlotConfigs(ctx, inputs));
  if (result.ok) revalidateSlotScreens();
  return result;
}

export async function createMealTypeAction(
  input: unknown,
): Promise<ActionResult<unknown>> {
  const { ctx } = await requireUser();
  const result = await runAction(() => createMealType(ctx, input));
  if (result.ok) revalidateSlotScreens();
  return result;
}

export async function renameMealTypeAction(
  mealTypeId: string,
  label: string,
): Promise<ActionResult<unknown>> {
  const { ctx } = await requireUser();
  const result = await runAction(() => renameMealType(ctx, mealTypeId, label));
  if (result.ok) revalidateSlotScreens();
  return result;
}

export async function deleteMealTypeAction(
  mealTypeId: string,
): Promise<ActionResult<void>> {
  const { ctx } = await requireUser();
  const result = await runAction(() => deleteMealType(ctx, mealTypeId));
  if (result.ok) revalidateSlotScreens();
  return result;
}

/**
 * Slot configuration changes what the week screen renders but never what an
 * existing plan version contains, so both screens are revalidated and no plan
 * is touched.
 */
function revalidateSlotScreens(): void {
  revalidatePath("/creneaux");
  revalidatePath("/semaine", "layout");
}
