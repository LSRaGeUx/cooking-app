import { getTranslations } from "next-intl/server";
import { RecipeForm } from "@/components/recipes/recipe-form";
import { RecipeImport } from "@/components/recipes/recipe-import";
import { requireUser } from "@/lib/session";

export default async function NewRecipePage() {
  await requireUser();
  const t = await getTranslations("recipes.form");

  return (
    <div className="page mx-auto flex w-full max-w-4xl flex-col gap-6">
      <h1 className="display border-b border-rule pb-4 text-3xl">
        {t("titleNew")}
      </h1>

      <RecipeImport />
      <p className="eyebrow eyebrow-rule">{t("or")}</p>

      <RecipeForm />
    </div>
  );
}
