import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { isDomainError } from "@/domain/errors";
import { RecipeImage } from "@/components/recipes/recipe-image";
import { pluralizeUnit } from "@/domain/units";
import { requireUser } from "@/lib/session";
import { sealClass } from "@/lib/recipe-seal";
import { getRecipe, type RecipeDetail } from "@/services/recipe-service";

/**
 * A recipe, split down the middle.
 *
 * The plate holds the left half and stays there while you scroll, because that
 * is the half you glance at, and the method holds the right half, because that
 * is the half you read. Nothing stacks: on a wide screen a recipe is two things
 * happening at once, not one long page you lose your place in.
 *
 * Quantities keep their own column so they can be scanned without reading the
 * names, and steps are numbered large in the margin so you can find your place
 * again after looking away at a pan.
 */
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

  const figures = [
    { label: t("prepTime"), value: recipe.prepTimeMin },
    { label: t("cookTime"), value: recipe.cookTimeMin },
    { label: t("activeTime"), value: recipe.activeTimeMin },
  ].filter(
    (figure): figure is { label: string; value: number } => figure.value !== null,
  );

  return (
    <article
      className={`${sealClass(recipe.id)} lg:grid lg:grid-cols-[minmax(0,34%)_minmax(0,1fr)]`}
    >
      {/* The plate. */}
      <div className="relative aspect-4/3 border-b-2 border-rule lg:sticky lg:top-0 lg:aspect-auto lg:h-[calc(100dvh_-_var(--bar-h))] lg:border-b-0 lg:border-r-2">
        <RecipeImage
          src={recipe.imageUrl}
          alt=""
          className="absolute inset-0 h-full w-full object-cover"
          fallback={
            <div className="seal-field absolute inset-0 flex items-center justify-center">
              <span aria-hidden="true" className="numeral text-[14rem] opacity-25">
                {[...recipe.title][0]?.toLocaleUpperCase() ?? "?"}
              </span>
            </div>
          }
        />
        <Link
          href={`/recettes/${recipe.id}/modifier`}
          className="btn absolute right-4 top-4"
        >
          {common("edit")}
        </Link>
      </div>

      {/* The method. */}
      <div className="flex flex-col">
        <div className="band bg-panel px-5 py-6 lg:px-8">
          <h1 className="big wipe">{recipe.title}</h1>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="chip chip-seal">
              {t("servings", { count: recipe.servings })}
            </span>
            <span className="chip">
              {t("revision", { number: recipe.revision })}
            </span>
            {recipe.deletedAt ? (
              <span className="chip chip-warn">{t("deleted")}</span>
            ) : null}
          </div>
          {recipe.description ? (
            <p className="lede mt-4">{recipe.description}</p>
          ) : null}
        </div>

        {figures.length > 0 || recipe.keepsDays !== null ? (
          <div
            className="wall border-t-0 border-l-0"
            style={{
              gridTemplateColumns: `repeat(${figures.length + (recipe.keepsDays !== null ? 1 : 0)}, minmax(0, 1fr))`,
            }}
          >
            {figures.map((figure) => (
              <div key={figure.label} className="block px-4 py-4">
                <div className="numeral text-3xl">{figure.value}</div>
                <div className="label-text mt-2 text-muted">{figure.label}</div>
              </div>
            ))}
            {recipe.keepsDays !== null ? (
              <div className="block px-4 py-4">
                <div className="numeral text-3xl">{recipe.keepsDays}</div>
                <div className="label-text mt-2 text-muted">
                  {t("keepsDays", { count: recipe.keepsDays })}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}

        <section className="band bg-panel">
          <h2 className="label-text border-b-2 border-rule bg-ink px-5 py-2 text-on-ink lg:px-8">
            {t("ingredients")}
          </h2>
          {ingredients.length === 0 ? (
            <p className="hint px-5 py-4 lg:px-8">{t("noIngredients")}</p>
          ) : (
            <ul className="ruled flex flex-col">
              {ingredients.map((line) => (
                <li
                  key={line.id}
                  className="grid grid-cols-[6rem_1fr] items-baseline gap-x-4 px-5 py-3 lg:px-8"
                >
                  <span className="label-text">
                    {[
                      line.quantity !== null ? formatQuantity(line.quantity) : null,
                      pluralizeUnit(line.unit, line.quantity),
                    ]
                      .filter((part) => part !== null && part !== "")
                      .join(" ")}
                  </span>
                  <span>
                    {line.rawName}
                    {line.note ? (
                      <span className="text-muted"> ({line.note})</span>
                    ) : null}
                    {line.optional ? (
                      <span className="text-muted"> ({common("optional")})</span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="bg-panel">
          <h2 className="label-text border-b-2 border-rule bg-ink px-5 py-2 text-on-ink lg:px-8">
            {t("steps")}
          </h2>
          {steps.length === 0 ? (
            <p className="hint px-5 py-4 lg:px-8">{t("noSteps")}</p>
          ) : (
            <ol className="ruled flex flex-col">
              {steps.map((step, index) => (
                <li key={step.id} className="flex gap-5 px-5 py-5 lg:px-8">
                  <span
                    aria-hidden="true"
                    className="numeral w-12 shrink-0 text-4xl text-seal"
                  >
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="flex flex-col gap-2">
                    <span className="prose max-w-[68ch]">{step.text}</span>
                    {step.durationMin !== null ? (
                      <span className="micro">
                        {common("minutes", { count: step.durationMin })}
                        {step.unattended ? ` · ${t("unattended")}` : ""}
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </article>
  );
}

/** Drops the trailing zeros a numeric column brings back: 3.000 reads as 3. */
function formatQuantity(quantity: number): string {
  return Number.isInteger(quantity)
    ? String(quantity)
    : String(Number(quantity.toFixed(2)));
}
