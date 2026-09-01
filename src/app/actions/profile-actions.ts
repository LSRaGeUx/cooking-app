"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import {
  createAllergen,
  createEquipment,
  createExclusion,
  deleteAllergen,
  deleteEquipment,
  deleteExclusion,
  updateProfile,
} from "@/services/profile-service";
import { runAction, type ActionResult } from "./result";

/**
 * Changing the profile changes what the planning rules enforce and what the
 * snapshot says, so both are revalidated. Nothing here touches an existing plan
 * version: history keeps the rules it was made under.
 */
function revalidateProfile(): void {
  revalidatePath("/profil");
  revalidatePath("/profil/apercu");
}

export async function updateProfileAction(
  input: unknown,
): Promise<ActionResult<unknown>> {
  const { ctx } = await requireUser();
  const result = await runAction(() =>
    updateProfile(ctx, input as Record<string, never>),
  );
  if (result.ok) revalidateProfile();
  return result;
}

export async function createAllergenAction(
  input: unknown,
): Promise<ActionResult<unknown>> {
  const { ctx } = await requireUser();
  const result = await runAction(() => createAllergen(ctx, input));
  if (result.ok) revalidateProfile();
  return result;
}

export async function deleteAllergenAction(
  allergenId: string,
): Promise<ActionResult<void>> {
  const { ctx } = await requireUser();
  const result = await runAction(() => deleteAllergen(ctx, allergenId));
  if (result.ok) revalidateProfile();
  return result;
}

export async function createExclusionAction(
  input: unknown,
): Promise<ActionResult<unknown>> {
  const { ctx } = await requireUser();
  const result = await runAction(() => createExclusion(ctx, input));
  if (result.ok) revalidateProfile();
  return result;
}

export async function deleteExclusionAction(
  exclusionId: string,
): Promise<ActionResult<void>> {
  const { ctx } = await requireUser();
  const result = await runAction(() => deleteExclusion(ctx, exclusionId));
  if (result.ok) revalidateProfile();
  return result;
}

export async function createEquipmentAction(
  input: unknown,
): Promise<ActionResult<unknown>> {
  const { ctx } = await requireUser();
  const result = await runAction(() => createEquipment(ctx, input));
  if (result.ok) revalidateProfile();
  return result;
}

export async function deleteEquipmentAction(
  equipmentId: string,
): Promise<ActionResult<void>> {
  const { ctx } = await requireUser();
  const result = await runAction(() => deleteEquipment(ctx, equipmentId));
  if (result.ok) revalidateProfile();
  return result;
}
