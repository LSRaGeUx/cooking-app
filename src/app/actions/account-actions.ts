"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { isDeleteConfirmation } from "@/lib/delete-confirmation";
import { requireUser } from "@/lib/session";
import { deleteAccount } from "@/services/account-service";
import { runAction, type ActionResult } from "./result";

/**
 * Deleting the account. There is no undo and no grace period: the soft-delete
 * window in this product covers recipes and plans, not the decision to leave.
 *
 * Three things were wrong here and all three are the same mistake in different
 * clothes: the action trusted its arguments and its own locale.
 *
 * It called `confirmation.trim()` before anything else, so a POST carrying a
 * number where the string was expected threw a TypeError and came back as a 500
 * rather than as the refusal every other bad input gets. The accepted words
 * were a two-element array written out here, while the screen compared against
 * `t("deleteConfirmWord")`, so a third locale would add a word to the interface
 * that the server silently refused. And the refusal itself was a French
 * sentence written in a server action, outside next-intl.
 *
 * `safeParse` rather than `parse`, because the check has to happen before the
 * service call and therefore outside `runAction`, which is the only thing that
 * turns a throw into a result.
 */
export async function deleteAccountAction(
  confirmation: unknown,
): Promise<ActionResult<void>> {
  const { ctx } = await requireUser();

  const typed = z.string().max(200).safeParse(confirmation);
  if (!typed.success) {
    return {
      ok: false,
      code: "VALIDATION",
      details: { field: "confirmation" },
    };
  }

  if (!(await isDeleteConfirmation(typed.data))) {
    // Its own code, not VALIDATION: the screen says which word to type, and
    // that sentence lives in the catalogues rather than here.
    return { ok: false, code: "DELETE_CONFIRMATION" };
  }

  const result = await runAction(() => deleteAccount(ctx));
  if (!result.ok) return result;

  // The session row went with the account, so the next request has no user.
  // Outside `runAction` on purpose: `redirect` works by throwing, and a catch
  // around it would swallow the navigation.
  redirect("/login");
}
