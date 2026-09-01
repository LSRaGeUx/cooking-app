import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { EmptyState } from "@/components/empty-state";
import { RecipeImage } from "@/components/recipes/recipe-image";
import { requireUser } from "@/lib/session";
import { sealClass } from "@/lib/recipe-seal";
import { searchRecipes } from "@/services/recipe-service";

/**
 * The library, as a contact sheet.
 *
 * Square tiles butted edge to edge on the lattice, each one either its
 * photograph or a flat field of the colour that recipe wears everywhere else.
 * No gaps and no cards: a library should read as one object, and the colour
 * does the work of telling the dishes apart.
 *
 * Search stays a GET form, so a filtered library is a URL, which is what makes
 * it shareable and what makes the back button behave.
 */
export default async function RecipesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const query = typeof params.q === "string" ? params.q : "";
  const maxActiveTime =
    typeof params.max === "string" && params.max.length > 0
      ? Number(params.max)
      : undefined;

  const { ctx } = await requireUser();
  const t = await getTranslations("recipes");
  const common = await getTranslations("common");

  const result = await searchRecipes(ctx, {
    ...(query.length > 0 ? { query } : {}),
    ...(maxActiveTime !== undefined && Number.isFinite(maxActiveTime)
      ? { maxActiveTimeMin: maxActiveTime }
      : {}),
    limit: 60,
  });

  return (
    <div className="flex flex-col">
      <section className="wall grid-cols-2 border-t-0 lg:grid-cols-[minmax(0,1fr)_auto_auto]">
        <div className="block col-span-2 px-5 py-6 lg:col-span-1 lg:px-8">
          <h1 className="mega wipe">{t("title")}</h1>
        </div>
        <div className="block flex flex-col justify-between gap-4 px-5 py-5 lg:min-w-40">
          <span aria-hidden="true" className="numeral text-5xl">
            {String(result.total).padStart(2, "0")}
          </span>
          <span className="sr-only">{t("count", { count: result.total })}</span>
          <span aria-hidden="true" className="label-text text-muted">
            {t("countLabel")}
          </span>
        </div>
        <Link
          href="/recettes/nouvelle"
          className="label-text fillable flex items-center justify-center bg-tomato px-6 py-5 text-on-tomato"
        >
          {t("new")}
        </Link>
      </section>

      <form className="band flex flex-wrap items-end gap-4 bg-panel px-5 py-4 lg:px-8">
        <label className="label max-w-md flex-1">
          <span>{common("search")}</span>
          <input
            type="search"
            name="q"
            defaultValue={query}
            placeholder={t("searchPlaceholder")}
            className="field"
          />
        </label>
        <label className="label w-44">
          <span>{t("maxActiveTime")}</span>
          <input
            type="number"
            name="max"
            min={0}
            defaultValue={params.max as string | undefined}
            className="field"
          />
        </label>
        <button type="submit" className="btn">
          {common("search")}
        </button>
      </form>

      {result.recipes.length === 0 ? (
        <div className="page">
          <EmptyState
            message={query.length > 0 ? t("emptySearch") : t("empty")}
            action={
              query.length > 0
                ? { href: "/recettes", label: t("clearSearch") }
                : { href: "/recettes/nouvelle", label: t("new") }
            }
          />
        </div>
      ) : (
        <ul className="wall grid-cols-2 border-t-0 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {result.recipes.map((recipe) => (
            <li key={recipe.id} className={sealClass(recipe.id)}>
              <Link
                href={`/recettes/${recipe.id}`}
                className="group relative flex aspect-square flex-col"
              >
                <RecipeImage
                  src={recipe.imageUrl}
                  alt=""
                  className="absolute inset-0 h-full w-full object-cover"
                  fallback={
                    <div className="seal-field absolute inset-0 flex items-center justify-center">
                      <span
                        aria-hidden="true"
                        className="numeral text-[6rem] opacity-25"
                      >
                        {[...recipe.title][0]?.toLocaleUpperCase() ?? "?"}
                      </span>
                    </div>
                  }
                />

                {/* The name sits in its own ruled bar, always legible, never
                    fighting a photograph we did not choose. */}
                <span className="fillable absolute inset-x-0 bottom-0 flex flex-col gap-0.5 border-t-2 border-rule bg-panel px-3 py-2.5">
                  <span className="name text-[0.95rem]">{recipe.title}</span>
                  <span className="text-xs opacity-60">
                    {common("servings", { count: recipe.servings })}
                    {recipe.activeTimeMin !== null
                      ? ` · ${common("minutes", { count: recipe.activeTimeMin })}`
                      : ""}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
