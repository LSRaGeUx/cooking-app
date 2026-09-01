import { parseHTML } from "linkedom";
import { parseIngredientLine } from "./ingredient-parser";

/**
 * Reading a recipe out of a web page, with no model involved.
 *
 * Most recipe sites publish schema.org Recipe as JSON-LD, because Google asks
 * them to. That covers the large majority at zero cost, which is the whole
 * reason this is worth building rather than handing every import to an agent.
 *
 * When it finds nothing, it says so clearly rather than guessing. The spec's
 * two-tier strategy depends on that: a clean failure is what invites the user's
 * agent to fetch the page itself and post a structured recipe, and a bad guess
 * would be worse than no guess at all.
 *
 * Nothing here trusts the page. Only text fields are extracted, they are never
 * rendered as HTML, and every string is length-capped before it can reach the
 * database.
 */

export interface ImportedRecipe {
  readonly title: string;
  readonly description: string | null;
  readonly servings: number;
  readonly prepTimeMin: number | null;
  readonly cookTimeMin: number | null;
  readonly activeTimeMin: number | null;
  readonly tags: string[];
  readonly cuisine: string | null;
  readonly ingredients: Array<{
    quantity: number | null;
    unit: string | null;
    rawName: string;
    note: string | null;
    optional: boolean;
    ingredientId: null;
  }>;
  readonly steps: Array<{
    text: string;
    durationMin: null;
    unattended: false;
  }>;
}

export interface ImportFailure {
  readonly ok: false;
  readonly reason: "no-recipe-found" | "not-html" | "empty";
}

export type ImportOutcome = { ok: true; recipe: ImportedRecipe } | ImportFailure;

export function extractRecipe(
  html: string,
  contentType: string | null,
): ImportOutcome {
  if (html.trim().length === 0) return { ok: false, reason: "empty" };
  if (contentType && !/html|xml/i.test(contentType)) {
    return { ok: false, reason: "not-html" };
  }

  const { document } = parseHTML(html);

  const fromJsonLd = findJsonLdRecipe(document);
  if (fromJsonLd) return { ok: true, recipe: normalize(fromJsonLd) };

  const fromMicrodata = findMicrodataRecipe(document);
  if (fromMicrodata) return { ok: true, recipe: normalize(fromMicrodata) };

  return { ok: false, reason: "no-recipe-found" };
}

/** The loose shape a page might give us, before any normalization. */
interface RawRecipe {
  name?: unknown;
  description?: unknown;
  recipeYield?: unknown;
  prepTime?: unknown;
  cookTime?: unknown;
  totalTime?: unknown;
  recipeCategory?: unknown;
  recipeCuisine?: unknown;
  keywords?: unknown;
  recipeIngredient?: unknown;
  ingredients?: unknown;
  recipeInstructions?: unknown;
}

function findJsonLdRecipe(document: Document): RawRecipe | null {
  const scripts = [
    ...document.querySelectorAll('script[type="application/ld+json"]'),
  ];

  for (const script of scripts) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(script.textContent ?? "");
    } catch {
      // A malformed block on a page is not our problem; try the next one.
      continue;
    }

    const found = searchForRecipe(parsed, 0);
    if (found) return found;
  }

  return null;
}

/**
 * A Recipe can be the root, an item in an array, or buried in an `@graph`.
 * Depth is capped so a pathological document cannot spin here.
 */
function searchForRecipe(node: unknown, depth: number): RawRecipe | null {
  if (depth > 6 || node === null || typeof node !== "object") return null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = searchForRecipe(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  const record = node as Record<string, unknown>;
  const type = record["@type"];
  const types = Array.isArray(type) ? type : [type];
  if (types.some((value) => typeof value === "string" && value === "Recipe")) {
    return record as RawRecipe;
  }

  for (const key of ["@graph", "mainEntity", "itemListElement"]) {
    const found = searchForRecipe(record[key], depth + 1);
    if (found) return found;
  }

  return null;
}

function findMicrodataRecipe(document: Document): RawRecipe | null {
  const scope = document.querySelector('[itemtype$="schema.org/Recipe"]');
  if (!scope) return null;

  const prop = (name: string): string | null => {
    const element = scope.querySelector(`[itemprop="${name}"]`);
    if (!element) return null;
    return (
      element.getAttribute("content") ?? element.textContent?.trim() ?? null
    );
  };

  const all = (name: string): string[] =>
    [...scope.querySelectorAll(`[itemprop="${name}"]`)]
      .map(
        (element) =>
          element.getAttribute("content") ?? element.textContent?.trim() ?? "",
      )
      .filter((value) => value.length > 0);

  const ingredients = all("recipeIngredient");
  const instructions = all("recipeInstructions");
  if (ingredients.length === 0 && instructions.length === 0) return null;

  return {
    name: prop("name"),
    description: prop("description"),
    recipeYield: prop("recipeYield"),
    prepTime: prop("prepTime"),
    cookTime: prop("cookTime"),
    recipeCuisine: prop("recipeCuisine"),
    recipeIngredient: ingredients,
    recipeInstructions: instructions,
  };
}

function normalize(raw: RawRecipe): ImportedRecipe {
  const ingredientLines = toStringArray(
    raw.recipeIngredient ?? raw.ingredients,
  ).slice(0, 100);

  const prep = parseIsoDuration(raw.prepTime);
  const cook = parseIsoDuration(raw.cookTime);
  const total = parseIsoDuration(raw.totalTime);

  return {
    title: cap(firstString(raw.name) ?? "Recette importée", 200),
    description: capOrNull(firstString(raw.description), 4000),
    servings: parseYield(raw.recipeYield),
    prepTimeMin: prep,
    cookTimeMin: cook,
    // Attended time is never published, so it is left unset rather than
    // guessed: it is the field the slot budget compares against, and a wrong
    // value there quietly breaks planning.
    activeTimeMin: null,
    tags: toStringArray(raw.keywords)
      .flatMap((value) => value.split(","))
      .map((value) => value.trim())
      .filter((value) => value.length > 0 && value.length <= 40)
      .slice(0, 10),
    cuisine: capOrNull(firstString(raw.recipeCuisine), 60),
    ingredients: ingredientLines.map((line) => {
      const parsed = parseIngredientLine(cap(line, 200));
      return {
        quantity: parsed.quantity,
        unit: parsed.unit,
        rawName: parsed.rawName,
        note: parsed.note,
        optional: parsed.optional,
        ingredientId: null,
      };
    }),
    steps: extractInstructions(raw.recipeInstructions)
      .slice(0, 100)
      .map((text) => ({
        text: cap(text, 4000),
        durationMin: null,
        unattended: false,
      })),
    ...(total !== null && prep === null && cook === null
      ? { cookTimeMin: total }
      : {}),
  };
}

/** Instructions come as a string, a list of strings, or HowToStep objects. */
function extractInstructions(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(/\n+/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  if (!Array.isArray(value)) return [];

  return value
    .flatMap((item): string[] => {
      if (typeof item === "string") return [item.trim()];
      if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        if (Array.isArray(record.itemListElement)) {
          return extractInstructions(record.itemListElement);
        }
        const text = firstString(record.text ?? record.name);
        return text ? [text.trim()] : [];
      }
      return [];
    })
    .filter((text) => text.length > 0);
}

/** `PT1H30M` is the only duration format schema.org uses. */
export function parseIsoDuration(value: unknown): number | null {
  const text = firstString(value);
  if (!text) return null;

  const match = /^P(?:\d+D)?T?(?:(\d+)H)?(?:(\d+)M)?/i.exec(text.trim());
  if (!match) return null;

  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const total = hours * 60 + minutes;
  return total > 0 && total <= 1440 ? total : null;
}

/** `recipeYield` is "4", "4 servings", "Pour 4 personnes", or an array. */
export function parseYield(value: unknown): number {
  const text = firstString(value);
  if (!text) return 2;
  const match = /\d+/.exec(text);
  if (!match) return 2;
  const parsed = Number(match[0]);
  return parsed >= 1 && parsed <= 50 ? parsed : 2;
}

function firstString(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstString(item);
      if (found) return found;
    }
  }
  return null;
}

function toStringArray(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const text = firstString(item);
    return text ? [text.trim()] : [];
  });
}

function cap(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function capOrNull(value: string | null, max: number): string | null {
  if (value === null) return null;
  const capped = cap(value, max);
  return capped.length > 0 ? capped : null;
}
