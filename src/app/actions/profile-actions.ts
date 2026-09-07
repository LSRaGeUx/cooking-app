"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  allergenInputSchema,
  equipmentInputSchema,
  exclusionInputSchema,
  profileInputSchema,
} from "@/domain/schemas";
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
import { runAction } from "./result";

/**
 * Changing the profile changes what the planning rules enforce and what the
 * snapshot says, so both are revalidated. Nothing here touches an existing plan
 * version: history keeps the rules it was made under.
 *
 * Return types are inferred from the services rather than declared as
 * `ActionResult<unknown>`, so the profile screen reads the saved row instead of
 * redeclaring a loose shape for it.
 */
function revalidateProfile(): void {
  revalidatePath("/profil");
  revalidatePath("/profil/apercu");
}

const idSchema = z.uuid();

export async function updateProfileAction(input: unknown) {
  const { ctx } = await requireUser();
  return runAction(async () => {
    /*
     * Parsed here rather than cast. This used to read
     * `updateProfile(ctx, input as Record<string, never>)`: a cast that told
     * the compiler the object matched the service's parameter type without
     * anything checking that it did, on a value that arrived over HTTP. The
     * parse produces exactly `Partial<ProfileInput>`, which is what the service
     * asks for, and a bad field comes back as VALIDATION.
     */
    const patch = profileInputSchema.partial().parse(input);
    const saved = await updateProfile(ctx, patch);
    revalidateProfile();
    return saved;
  });
}

export async function createAllergenAction(input: unknown) {
  const { ctx } = await requireUser();
  return runAction(async () => {
    const saved = await createAllergen(ctx, allergenInputSchema.parse(input));
    revalidateProfile();
    return saved;
  });
}

export async function deleteAllergenAction(allergenId: string) {
  const { ctx } = await requireUser();
  return runAction(async () => {
    await deleteAllergen(ctx, idSchema.parse(allergenId));
    revalidateProfile();
  });
}

export async function createExclusionAction(input: unknown) {
  const { ctx } = await requireUser();
  return runAction(async () => {
    const saved = await createExclusion(ctx, exclusionInputSchema.parse(input));
    revalidateProfile();
    return saved;
  });
}

export async function deleteExclusionAction(exclusionId: string) {
  const { ctx } = await requireUser();
  return runAction(async () => {
    await deleteExclusion(ctx, idSchema.parse(exclusionId));
    revalidateProfile();
  });
}

export async function createEquipmentAction(input: unknown) {
  const { ctx } = await requireUser();
  return runAction(async () => {
    const saved = await createEquipment(ctx, equipmentInputSchema.parse(input));
    revalidateProfile();
    return saved;
  });
}

export async function deleteEquipmentAction(equipmentId: string) {
  const { ctx } = await requireUser();
  return runAction(async () => {
    await deleteEquipment(ctx, idSchema.parse(equipmentId));
    revalidateProfile();
  });
}
