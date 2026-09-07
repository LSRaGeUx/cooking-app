"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { importRecipeAction } from "@/app/actions/recipe-actions";
import { Feedback } from "@/components/feedback";
import { useActionRunner } from "@/lib/use-action-runner";

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
  // The title an imported page gets when it publishes none. It used to be a
  // French literal inside the import service, which is UI copy living on the
  // server, so the screen supplies it instead.
  const fallback = useTranslations("recipes.import");
  const router = useRouter();
  const runner = useActionRunner();
  const urlId = useId();

  const [url, setUrl] = useState("");

  return (
    <section className="slip flex flex-col gap-3 border-l-[3px] border-l-ember p-4">
      <h2 className="eyebrow">{t("import")}</h2>
      <p className="hint">{t("importHelp")}</p>
      <Feedback error={runner.feedback} warnings={runner.warnings} />
      <div className="flex flex-wrap items-end gap-2">
        {/*
          A real label and the shared field class. The input was labelled by
          its placeholder alone, which disappears as soon as anything is typed,
          and it was the one text input in the application not wearing .field,
          so it did not look like a field at all.
        */}
        <label className="label min-w-[14rem] flex-1">
          <span>{t("importUrl")}</span>
          <input
            id={urlId}
            type="url"
            inputMode="url"
            value={url}
            placeholder={t("importPlaceholder")}
            onChange={(event) => setUrl(event.target.value)}
            className="field"
          />
        </label>
        <button
          type="button"
          disabled={runner.pending || url.trim().length === 0}
          onClick={() =>
            void runner.run(
              () => importRecipeAction(url.trim(), fallback("defaultTitle")),
              {
                refresh: false,
                onSuccess: (detail) => {
                  router.push(`/recettes/${detail.recipe.id}`);
                  router.refresh();
                },
              },
            )
          }
          className="btn btn-primary"
        >
          {runner.pending ? t("importing") : t("importSubmit")}
        </button>
      </div>
    </section>
  );
}
