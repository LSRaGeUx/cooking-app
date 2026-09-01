import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { RecipeForm } from "@/components/recipes/recipe-form";
import { isDomainError } from "@/domain/errors";
import { requireUser } from "@/lib/session";
import { getRecipe, type RecipeDetail } from "@/services/recipe-service";

export default async function EditRecipePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { ctx } = await requireUser();
  const t = await getTranslations("recipes.form");

  let detail: RecipeDetail;
  try {
    detail = await getRecipe(ctx, id);
  } catch (error) {
    if (isDomainError(error) && error.code === "RECIPE_NOT_FOUND") notFound();
    throw error;
  }

  return (
    <div className="page mx-auto flex w-full max-w-4xl flex-col gap-6">
      <h1 className="display border-b border-rule pb-4 text-3xl">
        {t("titleEdit")}
      </h1>
      <RecipeForm recipe={detail} />
    </div>
  );
}
