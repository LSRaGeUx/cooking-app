"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { searchRecipesAction } from "@/app/actions/recipe-actions";

export interface PickableRecipe {
  readonly id: string;
  readonly title: string;
  readonly activeTimeMin: number | null;
  readonly servings: number;
}

/**
 * Assigning a recipe to a slot. Search runs server-side through the same
 * service the MCP `search_recipes` tool will call, so "what the user can find"
 * and "what an agent can find" cannot diverge.
 */
export function RecipePicker({
  heading,
  initialRecipes,
  onPick,
  onClose,
  disabled = false,
}: {
  heading: string;
  initialRecipes: readonly PickableRecipe[];
  onPick: (recipeId: string) => void;
  onClose: () => void;
  disabled?: boolean;
}) {
  const t = useTranslations("recipes");
  const common = useTranslations("common");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<readonly PickableRecipe[]>(
    initialRecipes,
  );
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    if (query.trim().length === 0) {
      setResults(initialRecipes);
      return;
    }

    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(async () => {
      const result = await searchRecipesAction({ query, limit: 20 });
      if (cancelled) return;
      setSearching(false);
      if (result.ok) {
        setResults(
          result.data.recipes.map((recipe) => ({
            id: recipe.id,
            title: recipe.title,
            activeTimeMin: recipe.activeTimeMin,
            servings: recipe.servings,
          })),
        );
      }
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, initialRecipes]);

  return (
    <div
      role="dialog"
      aria-label={heading}
      className="slip-float flex flex-col gap-3 p-3"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="eyebrow">{heading}</h3>
        <button type="button" onClick={onClose} className="link text-xs">
          {common("close")}
        </button>
      </div>

      <input
        ref={inputRef}
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={t("searchPlaceholder")}
        className="field"
      />

      <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
        {results.length === 0 ? (
          <li className="px-1 py-2 text-sm text-muted">
            {searching ? common("loading") : t("emptySearch")}
          </li>
        ) : (
          results.map((recipe) => (
            <li key={recipe.id}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onPick(recipe.id)}
                className="flex w-full flex-col items-start gap-0.5 rounded-[2px] border-l-2 border-transparent px-2 py-1.5 text-left transition-colors hover:border-ember hover:bg-ember-soft disabled:opacity-50"
              >
                <span className="display text-[0.95rem] leading-snug">
                  {recipe.title}
                </span>
                {recipe.activeTimeMin !== null ? (
                  <span className="micro">
                    {common("minutes", { count: recipe.activeTimeMin })}
                  </span>
                ) : null}
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
