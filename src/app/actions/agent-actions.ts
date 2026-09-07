"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/session";
import { revokeClient } from "@/services/agent-client-service";
import { runAction, type ActionResult } from "./result";

/**
 * An OAuth client id is not a UUID: it is whatever the authorization server
 * issued. Bounded and required, then, rather than shaped.
 */
const clientIdSchema = z.string().min(1).max(255);

export async function revokeClientAction(
  clientId: string,
): Promise<ActionResult<void>> {
  const { ctx } = await requireUser();
  return runAction(async () => {
    await revokeClient(ctx, clientIdSchema.parse(clientId));
    revalidatePath("/agent");
    revalidatePath("/agent/activite");
  });
}
