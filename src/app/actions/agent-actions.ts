"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { revokeClient } from "@/services/agent-client-service";
import { runAction, type ActionResult } from "./result";

export async function revokeClientAction(
  clientId: string,
): Promise<ActionResult<void>> {
  const { ctx } = await requireUser();
  const result = await runAction(() => revokeClient(ctx, clientId));
  if (result.ok) revalidatePath("/agent");
  return result;
}
