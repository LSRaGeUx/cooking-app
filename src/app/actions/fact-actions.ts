"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { factInputSchema, factMetadataSchema } from "@/domain/schemas";
import { requireUser } from "@/lib/session";
import {
  confirmFact,
  createFact,
  retireFact,
  supersedeFact,
  updateFactMetadata,
  type FactView,
  type SupersedeResult,
} from "@/services/fact-service";
import { runAction, type ActionResult } from "./result";

const factIdSchema = z.uuid();

function revalidateFacts(): void {
  revalidatePath("/faits");
  revalidatePath("/profil/apercu");
}

export async function createFactAction(
  input: unknown,
): Promise<ActionResult<FactView>> {
  const { ctx } = await requireUser();
  return runAction(async () => {
    const saved = await createFact(ctx, factInputSchema.parse(input));
    revalidateFacts();
    return saved;
  });
}

export async function confirmFactAction(
  factId: string,
): Promise<ActionResult<FactView>> {
  const { ctx } = await requireUser();
  return runAction(async () => {
    const saved = await confirmFact(ctx, factIdSchema.parse(factId));
    revalidateFacts();
    return saved;
  });
}

/**
 * The in-place edit: how a fact is filed and how sure we are of it. Deliberately
 * narrow. The statement and the polarity are the fact's meaning, and changing a
 * meaning in place is what the supersede path exists to prevent, so the facts
 * screen calls this when only the filing changed and `supersedeFactAction` when
 * the claim itself did.
 */
export async function updateFactMetadataAction(
  factId: string,
  changes: unknown,
): Promise<ActionResult<FactView>> {
  const { ctx } = await requireUser();
  return runAction(async () => {
    const saved = await updateFactMetadata(
      ctx,
      factIdSchema.parse(factId),
      factMetadataSchema.parse(changes),
    );
    revalidateFacts();
    return saved;
  });
}

export async function retireFactAction(
  factId: string,
): Promise<ActionResult<FactView>> {
  const { ctx } = await requireUser();
  return runAction(async () => {
    const saved = await retireFact(ctx, factIdSchema.parse(factId));
    revalidateFacts();
    return saved;
  });
}

/**
 * The only way to change what a fact says. It retires the old row and writes a
 * new one pointing back at it, so a taste that changed stays legible.
 */
export async function supersedeFactAction(
  factId: string,
  input: unknown,
): Promise<ActionResult<SupersedeResult>> {
  const { ctx } = await requireUser();
  return runAction(async () => {
    const saved = await supersedeFact(
      ctx,
      factIdSchema.parse(factId),
      factInputSchema.parse(input),
    );
    revalidateFacts();
    return saved;
  });
}
