import { getTranslations } from "next-intl/server";
import { RecipeForm } from "@/components/recipes/recipe-form";
import { RecipeImport } from "@/components/recipes/recipe-import";
import { requireUser } from "@/lib/session";

export default async function NewRecipePage() {
  await requireUser();
  const t = await getTranslations("recipes.form");

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl font-semibold">{t("titleNew")}</h1>

      <RecipeImport />
      <p className="text-xs uppercase tracking-wide opacity-50">{t("or")}</p>

      <RecipeForm />
    </div>
  );
}
