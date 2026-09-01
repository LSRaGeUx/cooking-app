import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { requireUser } from "@/lib/session";
import { searchRecipes } from "@/services/recipe-service";

/**
 * The library. Search is a GET form so a filtered library is a URL, which is
 * what makes it shareable and what makes the back button behave.
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
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h1 className="text-2xl font-semibold">{t("title")}</h1>
          <span className="text-sm opacity-60">
            {t("count", { count: result.total })}
          </span>
        </div>
        <Link
          href="/recettes/nouvelle"
          className="rounded-md bg-black px-3 py-1.5 text-sm font-medium text-white dark:bg-white dark:text-black"
        >
          {t("new")}
        </Link>
      </header>

      <form className="flex flex-wrap items-end gap-3">
        <label className="flex flex-1 flex-col gap-1 text-sm">
          <span className="font-medium">{common("search")}</span>
          <input
            type="search"
            name="q"
            defaultValue={query}
            placeholder={t("searchPlaceholder")}
            className="rounded-md border border-black/15 px-3 py-2 dark:border-white/20"
          />
        </label>
        <label className="flex w-40 flex-col gap-1 text-sm">
          <span className="font-medium">{t("maxActiveTime")}</span>
          <input
            type="number"
            name="max"
            min={0}
            defaultValue={params.max as string | undefined}
            className="rounded-md border border-black/15 px-3 py-2 dark:border-white/20"
          />
        </label>
        <button
          type="submit"
          className="rounded-md border border-black/15 px-3 py-2 text-sm dark:border-white/20"
        >
          {common("search")}
        </button>
      </form>

      {result.recipes.length === 0 ? (
        <p className="text-sm opacity-70">
          {query.length > 0 ? t("emptySearch") : t("empty")}
        </p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {result.recipes.map((recipe) => (
            <li key={recipe.id}>
              <Link
                href={`/recettes/${recipe.id}`}
                className="flex h-full flex-col gap-1 rounded-md border border-black/15 p-3 hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/5"
              >
                <span className="font-medium">{recipe.title}</span>
                <span className="text-xs opacity-60">
                  {common("servings", { count: recipe.servings })}
                  {recipe.activeTimeMin !== null
                    ? ` · ${common("minutes", { count: recipe.activeTimeMin })}`
                    : ""}
                </span>
                {recipe.tags.length > 0 ? (
                  <span className="text-xs opacity-50">
                    {recipe.tags.join(" · ")}
                  </span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
