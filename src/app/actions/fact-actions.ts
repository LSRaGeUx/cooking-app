"use server";

import { revalidatePath } from "next/cache";
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

function revalidateFacts(): void {
  revalidatePath("/faits");
  revalidatePath("/profil/apercu");
}

export async function createFactAction(
  input: unknown,
): Promise<ActionResult<FactView>> {
  const { ctx } = await requireUser();
  const result = await runAction(() => createFact(ctx, input));
  if (result.ok) revalidateFacts();
  return result;
}

export async function confirmFactAction(
  factId: string,
): Promise<ActionResult<FactView>> {
  const { ctx } = await requireUser();
  const result = await runAction(() => confirmFact(ctx, factId));
  if (result.ok) revalidateFacts();
  return result;
}

export async function updateFactMetadataAction(
  factId: string,
  changes: unknown,
): Promise<ActionResult<FactView>> {
  const { ctx } = await requireUser();
  const result = await runAction(() => updateFactMetadata(ctx, factId, changes));
  if (result.ok) revalidateFacts();
  return result;
}

export async function retireFactAction(
  factId: string,
): Promise<ActionResult<FactView>> {
  const { ctx } = await requireUser();
  const result = await runAction(() => retireFact(ctx, factId));
  if (result.ok) revalidateFacts();
  return result;
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
  const result = await runAction(() => supersedeFact(ctx, factId, input));
  if (result.ok) revalidateFacts();
  return result;
}
