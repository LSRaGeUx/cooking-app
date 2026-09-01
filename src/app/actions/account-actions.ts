"use server";

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/session";
import { deleteAccount } from "@/services/account-service";
import { runAction, type ActionResult } from "./result";

/**
 * Deleting the account. There is no undo and no grace period: the soft-delete
 * window in this product covers recipes and plans, not the decision to leave.
 */
export async function deleteAccountAction(
  confirmation: string,
): Promise<ActionResult<void>> {
  const { ctx } = await requireUser();

  // Both words are accepted, because the screen shows whichever one matches the
  // reader's language and the server must not depend on which locale a cookie
  // happened to hold.
  const CONFIRMATION_WORDS = ["SUPPRIMER", "DELETE"];
  if (!CONFIRMATION_WORDS.includes(confirmation.trim().toUpperCase())) {
    return {
      ok: false,
      code: "VALIDATION",
      message:
        "Tapez le mot de confirmation. Cette action efface définitivement toutes vos données.",
    };
  }

  const result = await runAction(() => deleteAccount(ctx));
  if (!result.ok) return result;

  // The session row went with the account, so the next request has no user.
  redirect("/login");
}
