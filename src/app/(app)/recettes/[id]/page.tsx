import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { isDomainError } from "@/domain/errors";
import { pluralizeUnit } from "@/domain/units";
import { requireUser } from "@/lib/session";
import { getRecipe, type RecipeDetail } from "@/services/recipe-service";

export default async function RecipePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { ctx } = await requireUser();

  let detail: RecipeDetail;
  try {
    detail = await getRecipe(ctx, id);
  } catch (error) {
    if (isDomainError(error) && error.code === "RECIPE_NOT_FOUND") notFound();
    throw error;
  }

  const t = await getTranslations("recipes.detail");
  const common = await getTranslations("common");
  const { recipe, ingredients, steps } = detail;

  return (
    <article className="flex flex-col gap-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">{recipe.title}</h1>
          <p className="text-sm opacity-70">
            {t("servings", { count: recipe.servings })} ·{" "}
            {t("revision", { number: recipe.revision })}
          </p>
          {recipe.description ? (
            <p className="text-sm opacity-80">{recipe.description}</p>
          ) : null}
        </div>
        <Link
          href={`/recettes/${recipe.id}/modifier`}
          className="rounded-md border border-black/15 px-3 py-1.5 text-sm dark:border-white/20"
        >
          {common("edit")}
        </Link>
      </header>

      {recipe.deletedAt ? (
        <p className="rounded-md border border-amber-500/40 px-3 py-2 text-sm">
          {t("deleted")}
        </p>
      ) : null}

      <dl className="flex flex-wrap gap-6 text-sm">
        {recipe.prepTimeMin !== null ? (
          <div>
            <dt className="opacity-60">{t("prepTime")}</dt>
            <dd>{common("minutes", { count: recipe.prepTimeMin })}</dd>
          </div>
        ) : null}
        {recipe.cookTimeMin !== null ? (
          <div>
            <dt className="opacity-60">{t("cookTime")}</dt>
            <dd>{common("minutes", { count: recipe.cookTimeMin })}</dd>
          </div>
        ) : null}
        {recipe.activeTimeMin !== null ? (
          <div>
            <dt className="opacity-60">{t("activeTime")}</dt>
            <dd>{common("minutes", { count: recipe.activeTimeMin })}</dd>
          </div>
        ) : null}
        {recipe.keepsDays !== null ? (
          <div>
            <dt className="opacity-60">{t("keepsDays", { count: recipe.keepsDays })}</dt>
            <dd />
          </div>
        ) : null}
      </dl>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium uppercase tracking-wide opacity-60">
          {t("ingredients")}
        </h2>
        <ul className="flex flex-col gap-1 text-sm">
          {ingredients.map((line) => (
            <li key={line.id} className="flex flex-wrap gap-1">
              <span>
                {[
                  line.quantity !== null ? formatQuantity(line.quantity) : null,
                  pluralizeUnit(line.unit, line.quantity),
                  line.rawName,
                ]
                  .filter((part) => part !== null && part !== "")
                  .join(" ")}
              </span>
              {line.note ? (
                <span className="opacity-60">({line.note})</span>
              ) : null}
              {line.optional ? (
                <span className="opacity-60">({common("optional")})</span>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium uppercase tracking-wide opacity-60">
          {t("steps")}
        </h2>
        <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm">
          {steps.map((step) => (
            <li key={step.id}>
              <span>{step.text}</span>
              {step.durationMin !== null ? (
                <span className="opacity-60">
                  {" "}
                  · {common("minutes", { count: step.durationMin })}
                  {step.unattended ? ` (${t("unattended")})` : ""}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      </section>
    </article>
  );
}

/** Drops the trailing zeros a numeric column brings back: 3.000 reads as 3. */
function formatQuantity(quantity: number): string {
  return Number.isInteger(quantity)
    ? String(quantity)
    : String(Number(quantity.toFixed(2)));
}
