"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  deleteRecipeAction,
  restoreRecipeAction,
} from "@/app/actions/recipe-actions";
import { Feedback } from "@/components/feedback";
import { useActionRunner } from "@/lib/use-action-runner";

/**
 * Deleting a recipe, and undeleting it.
 *
 * `deleteRecipeAction` was exported with no caller anywhere, so the only way to
 * remove a recipe was over MCP, and `restoreRecipe` had no caller either. That
 * left the soft delete half implemented: rule 5 promises a 30-day window in
 * which a user-visible delete can be taken back, and a window nothing in the
 * interface can reach is not a window.
 *
 * Deleting is not behind a typed confirmation, unlike the account. It is
 * reversible for thirty days and the chip on the page says so, which is the
 * whole point of a soft delete: friction proportional to consequence.
 */
export function RecipeLifecycle({
  recipeId,
  deleted,
}: {
  recipeId: string;
  deleted: boolean;
}) {
  const t = useTranslations("recipes.detail");
  const common = useTranslations("common");
  const router = useRouter();
  const runner = useActionRunner();

  return (
    <div className="flex flex-col gap-2">
      <Feedback error={runner.feedback} warnings={runner.warnings} />
      {deleted ? (
        <button
          type="button"
          disabled={runner.pending}
          onClick={() => void runner.run(() => restoreRecipeAction(recipeId))}
          className="btn btn-primary btn-sm self-start"
        >
          {t("restore")}
        </button>
      ) : (
        <button
          type="button"
          disabled={runner.pending}
          onClick={() =>
            void runner.run(() => deleteRecipeAction(recipeId), {
              refresh: false,
              onSuccess: () => {
                // Back to the library: the detail page of a deleted recipe is
                // still readable, but it is not where the reader wants to be.
                router.push("/recettes");
                router.refresh();
              },
            })
          }
          className="btn btn-danger btn-sm self-start"
        >
          {common("delete")}
        </button>
      )}
      {deleted ? <p className="hint">{t("restoreHelp")}</p> : null}
    </div>
  );
}
