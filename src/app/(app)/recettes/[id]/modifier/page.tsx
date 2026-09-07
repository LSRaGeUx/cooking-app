import { getTranslations } from "next-intl/server";
import { RecipeForm } from "@/components/recipes/recipe-form";
import { loadRecipeOr404 } from "@/lib/page-data";
import { requireUser } from "@/lib/session";

export default async function EditRecipePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { ctx } = await requireUser();
  const t = await getTranslations("recipes.form");

  // One helper, shared with the detail page, which carried the same try/catch.
  const detail = await loadRecipeOr404(ctx, id);

  return (
    <div className="page mx-auto flex w-full max-w-4xl flex-col gap-6">
      <h1 className="display border-b border-rule pb-4 text-3xl">
        {t("titleEdit")}
      </h1>
      <RecipeForm recipe={detail} />
    </div>
  );
}
