"use client";

import { useEffect, useId, useRef, useState } from "react";
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
 *
 * The search is driven from the change handler rather than from an effect. It
 * used to be an effect that called `setSearching(true)` in its own body, which
 * React's hooks lint now reports, and that did the awaiting inside a
 * `setTimeout` callback with no `catch`: a rejected action left `searching`
 * true forever and logged an unhandled rejection. Debouncing is a property of
 * the input, not of the render, so it lives with the input.
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
  const searchId = useId();

  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState<
    readonly PickableRecipe[] | null
  >(null);
  const [searching, setSearching] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Answers can arrive out of order, and the last one asked for is the only one
  // the user is waiting on.
  const generation = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  async function search(text: string, forGeneration: number): Promise<void> {
    try {
      const result = await searchRecipesAction({ query: text, limit: 20 });
      if (generation.current !== forGeneration) return;
      if (result.ok) {
        setSearchResults(
          result.data.recipes.map((recipe) => ({
            id: recipe.id,
            title: recipe.title,
            activeTimeMin: recipe.activeTimeMin,
            servings: recipe.servings,
          })),
        );
      }
    } catch (error) {
      // A search that could not reach the server leaves the last results on
      // screen. There is a picker open and a list in it; a banner here would
      // cover the thing the user is trying to read.
      console.error("Recipe search did not complete", error);
    } finally {
      if (generation.current === forGeneration) setSearching(false);
    }
  }

  function onQueryChange(value: string): void {
    setQuery(value);
    if (timer.current !== null) clearTimeout(timer.current);

    const trimmed = value.trim();
    generation.current += 1;
    const forGeneration = generation.current;

    if (trimmed.length === 0) {
      setSearchResults(null);
      setSearching(false);
      return;
    }

    setSearching(true);
    timer.current = setTimeout(() => {
      void search(trimmed, forGeneration);
    }, 250);
  }

  // An empty box shows the library the page already loaded; a query shows only
  // what the server answered, so a stale list cannot look like a result.
  const results =
    query.trim().length === 0 ? initialRecipes : (searchResults ?? []);

  return (
    <div className="flex flex-col gap-3 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="eyebrow">{heading}</h3>
        <button type="button" onClick={onClose} className="link text-xs">
          {common("close")}
        </button>
      </div>

      {/*
        A real label, visually hidden. The input was labelled by its
        placeholder alone, which disappears the moment anything is typed and
        which several screen readers do not announce at all.
      */}
      <label htmlFor={searchId} className="sr-only">
        {common("search")}
      </label>
      <input
        id={searchId}
        ref={inputRef}
        type="search"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
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
