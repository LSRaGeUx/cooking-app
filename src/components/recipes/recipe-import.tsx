"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { importRecipeAction } from "@/app/actions/recipe-actions";
import { Feedback, type FeedbackState } from "@/components/feedback";

/**
 * Tier one of the import, from the user's side.
 *
 * When it fails, the message from the service is shown as written: it explains
 * that the page publishes nothing structured and suggests asking an agent to
 * read it instead. Softening that into "import failed" would hide the one
 * useful thing the user can do next.
 */
export function RecipeImport() {
  const t = useTranslations("recipes.form");
  const router = useRouter();

  const [url, setUrl] = useState("");
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackState>({});

  async function submit(): Promise<void> {
    if (url.trim().length === 0) return;
    setPending(true);
    const result = await importRecipeAction(url.trim());
    setPending(false);

    if (!result.ok) {
      setFeedback({
        error: {
          code: result.code,
          message: result.message,
          details: result.details,
        },
      });
      return;
    }
    router.push(`/recettes/${result.data.recipe.id}`);
    router.refresh();
  }

  return (
    <section className="slip flex flex-col gap-3 border-l-[3px] border-l-ember p-4">
      <h2 className="eyebrow">{t("import")}</h2>
      <p className="hint">{t("importHelp")}</p>
      <Feedback {...feedback} />
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="url"
          value={url}
          placeholder={t("importPlaceholder")}
          onChange={(event) => setUrl(event.target.value)}
          className="min-w-[14rem] flex-1"
        />
        <button
          type="button"
          disabled={pending || url.trim().length === 0}
          onClick={() => void submit()}
          className="btn btn-primary"
        >
          {pending ? t("importing") : t("importSubmit")}
        </button>
      </div>
    </section>
  );
}
