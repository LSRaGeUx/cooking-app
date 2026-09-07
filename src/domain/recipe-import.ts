import { parseHTML } from "linkedom";
import type { z } from "zod";
import { parseIngredientLine } from "./ingredient-parser";
import { recipeInputSchema } from "./schemas";

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

/**
 * What an import produces, typed from the schema that validates a recipe on
 * every other path (rule 9).
 *
 * This used to be a hand-written interface restating the recipe, ingredient and
 * step shapes, and `normalize` never ran through the schema at all, so an
 * import could produce an empty title or an empty `rawName`: both violate the
 * schema's `min(1)`, and the failure surfaced at the insert rather than at the
 * import. Deriving the type means the two can no longer disagree, and the parse
 * at the end of `normalize` means the import path cannot bypass the rules.
 *
 * One deliberate difference from `recipeInputSchema`: `title` may be null. A
 * page that publishes a Recipe with no name is rare and real, and the domain
 * has no business inventing a French placeholder for it. The screen supplies
 * one through next-intl instead.
 */
const importedRecipeSchema = recipeInputSchema.extend({
  title: recipeInputSchema.shape.title.nullable(),
});

export type ImportedRecipe = z.infer<typeof importedRecipeSchema>;

export interface ImportFailure {
  readonly ok: false;
  readonly reason: "no-recipe-found" | "not-html" | "empty";
}

export type ImportOutcome =
  | { ok: true; recipe: ImportedRecipe }
  | ImportFailure;

export function extractRecipe(
  html: string,
  contentType: string | null,
): ImportOutcome {
  if (html.trim().length === 0) return { ok: false, reason: "empty" };
  if (contentType && !/html|xml/i.test(contentType)) {
    return { ok: false, reason: "not-html" };
  }

  const { document } = parseHTML(html);

  // Each source is tried, and a source whose markup does not survive the schema
  // is treated as not having been found: that is what lets a page with a broken
  // JSON-LD block still import from its microdata. A page with neither reports
  // `no-recipe-found`, which is the clean failure the two-tier strategy needs,
  // rather than a validation error the user cannot act on.
  const fromJsonLd = findJsonLdRecipe(document);
  const jsonLdRecipe = fromJsonLd ? normalize(fromJsonLd) : null;
  if (jsonLdRecipe) return { ok: true, recipe: jsonLdRecipe };

  const fromMicrodata = findMicrodataRecipe(document);
  const microdataRecipe = fromMicrodata ? normalize(fromMicrodata) : null;
  if (microdataRecipe) return { ok: true, recipe: microdataRecipe };

  return { ok: false, reason: "no-recipe-found" };
}

/** The loose shape a page might give us, before any normalization. */
interface RawRecipe {
  name?: unknown;
  description?: unknown;
  image?: unknown;
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
  if (types.some(isRecipeType)) {
    return record as RawRecipe;
  }

  for (const key of ["@graph", "mainEntity", "itemListElement"]) {
    const found = searchForRecipe(record[key], depth + 1);
    if (found) return found;
  }

  return null;
}

/**
 * Whether an `@type` names schema.org's Recipe.
 *
 * All three of `Recipe`, `https://schema.org/Recipe` and `schema:Recipe` are
 * common in the wild, and only the bare form used to be recognized, so an
 * otherwise perfectly marked-up page reported `no-recipe-found`. Comparing the
 * last path segment covers the fully qualified form, the compact IRI, and the
 * `http` spelling, without accepting something merely ending in the word.
 */
function isRecipeType(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const segments = value.trim().split(/[/#:]/);
  return segments[segments.length - 1] === "Recipe";
}

function findMicrodataRecipe(document: Document): RawRecipe | null {
  const scope = document.querySelector('[itemtype$="schema.org/Recipe"]');
  if (!scope) return null;

  /**
   * Whether an `itemprop` belongs to the recipe itself rather than to something
   * nested inside it.
   *
   * Microdata nests: an author, a nutrition block and a rating are each their
   * own `itemscope` inside the recipe, and each has its own `name`. Taking the
   * first `[itemprop="name"]` in document order therefore imported the author's
   * name as the recipe title on a great many real pages. The nearest enclosing
   * `itemscope` of a property that belongs to the recipe is the recipe scope,
   * and for a nested item it is that item, so the comparison is the whole rule.
   */
  const ownProperty = (element: Element): boolean =>
    element.closest("[itemscope]") === scope;

  const prop = (name: string): string | null => {
    const element = [...scope.querySelectorAll(`[itemprop="${name}"]`)].find(
      ownProperty,
    );
    if (!element) return null;
    return (
      element.getAttribute("content") ?? element.textContent?.trim() ?? null
    );
  };

  // Deliberately unscoped, unlike `prop`. Instructions are routinely published
  // as nested HowToStep items, each its own itemscope, so requiring the recipe
  // to be the nearest scope would drop exactly the pages that mark up their
  // steps properly. Both of these properties are lists of text in every real
  // shape, and neither collides with a name a nested item would carry.
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
    totalTime: prop("totalTime"),
    recipeCategory: prop("recipeCategory"),
    recipeCuisine: prop("recipeCuisine"),
    keywords: prop("keywords"),
    recipeIngredient: ingredients,
    recipeInstructions: instructions,
  };
}

/**
 * The parsed page as a recipe, or null when nothing survives validation.
 *
 * Null rather than a thrown error: a page can carry a Recipe block that says
 * almost nothing, and the caller's answer to that is to fall through to the
 * next source and then to the clean `no-recipe-found` failure that invites the
 * user's agent to try instead. See `extractRecipe`.
 */
function normalize(raw: RawRecipe): ImportedRecipe | null {
  const ingredientLines = toStringArray(raw.recipeIngredient ?? raw.ingredients)
    // A blank line would parse to an empty `rawName`, which the schema refuses,
    // and one such line would otherwise cost the whole import.
    .filter((line) => line.trim().length > 0)
    .slice(0, 100);

  const prep = parseIsoDuration(raw.prepTime);
  const cook = parseIsoDuration(raw.cookTime);
  const total = parseIsoDuration(raw.totalTime);

  // Computed once, in place. This used to be set here and then overridden by a
  // conditional spread at the end of the object literal, which reads as a
  // mistake even when it is not, and hides the rule. The rule: a page that
  // publishes only a total time has told us how long the dish takes but not
  // how that splits, and total time is closer to cook time than to prep.
  const cookTimeMin = cook ?? (prep === null ? total : null);

  const draft = {
    title: capOrNull(firstString(raw.name), 200),
    description: capOrNull(firstString(raw.description), 4000),
    imageUrl: pickImage(raw.image),
    servings: parseYield(raw.recipeYield),
    prepTimeMin: prep,
    cookTimeMin,
    // Attended time is never published, so it is left unset rather than
    // guessed: it is the field the slot budget compares against, and a wrong
    // value there quietly breaks planning.
    activeTimeMin: null,
    tags: parseTags(raw.keywords, raw.recipeCategory),
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
  };

  const parsed = importedRecipeSchema.safeParse(draft);
  if (parsed.success) return parsed.data;

  // One field is not worth losing a whole recipe over, and the image is the
  // field most likely to fail: `pickImage` checks the scheme and the length,
  // and the schema also insists on a parseable URL. Everything else that can
  // fail here is structural.
  const withoutImage = importedRecipeSchema.safeParse({
    ...draft,
    imageUrl: null,
  });
  return withoutImage.success ? withoutImage.data : null;
}

/**
 * `keywords` plus `recipeCategory`, deduplicated.
 *
 * The category was read off the page and then never used, which is a field of
 * free signal thrown away: "Dessert" or "Plat principal" is exactly the sort of
 * tag the library filters on. The cap is 30, matching
 * `recipeInputSchema.tags`; it used to be 10 here, so a well-tagged page lost
 * two thirds of its tags to a limit that was not the real one.
 */
function parseTags(keywords: unknown, category: unknown): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];

  for (const source of [keywords, category]) {
    for (const value of toStringArray(source).flatMap((entry) =>
      entry.split(","),
    )) {
      const tag = value.trim();
      if (tag.length === 0 || tag.length > 40) continue;
      const key = tag.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      tags.push(tag);
      if (tags.length === 30) return tags;
    }
  }

  return tags;
}

/**
 * `image` is a URL, a list of URLs, or an ImageObject with a `url`.
 *
 * Only https survives. The image is not copied onto the server, so the address
 * ends up in the reader's browser, and an http one would be a mixed-content
 * request the page would block anyway.
 */
function pickImage(value: unknown): string | null {
  const candidates: unknown[] = Array.isArray(value) ? value : [value];

  for (const candidate of candidates) {
    const text =
      typeof candidate === "object" && candidate !== null
        ? firstString((candidate as Record<string, unknown>).url)
        : firstString(candidate);

    if (text && /^https:\/\//i.test(text.trim()) && text.length <= 2000) {
      return text.trim();
    }
  }

  return null;
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

/**
 * `PT1H30M`, in minutes.
 *
 * **The `T` is not optional**, and treating it as optional was the bug: `M`
 * means months in the date part of an ISO-8601 duration and minutes only after
 * the `T`, so `P1M`, which a handful of sites emit as a placeholder, was read
 * as one minute and published as a one-minute cooking time. Requiring the `T`
 * makes a date-only duration return null, which is the honest answer: we do not
 * know the cooking time, so nothing is stored.
 *
 * Fractional counts are accepted, because `PT1.5H` is valid ISO-8601 and used
 * to return null. The result is rounded to whole minutes, which is what the
 * column holds.
 */
export function parseIsoDuration(value: unknown): number | null {
  const text = firstString(value);
  if (!text) return null;

  const match =
    /^P(?:\d+(?:[.,]\d+)?[YMWD])*(?:T(?:(\d+(?:[.,]\d+)?)H)?(?:(\d+(?:[.,]\d+)?)M)?(?:(\d+(?:[.,]\d+)?)S)?)?$/i.exec(
      text.trim(),
    );
  if (!match) return null;

  const hours = decimalOf(match[1]);
  const minutes = decimalOf(match[2]);
  const seconds = decimalOf(match[3]);
  const total = Math.round(hours * 60 + minutes + seconds / 60);
  return total > 0 && total <= 1440 ? total : null;
}

function decimalOf(value: string | undefined): number {
  if (value === undefined) return 0;
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : 0;
}

/** What a recipe with no usable yield is assumed to serve. */
const DEFAULT_SERVINGS = 2;

/**
 * `recipeYield` is "4", "4 servings", "Pour 4 personnes", "4-6 servings", or an
 * array of those.
 *
 * A range takes its upper bound, which is what the ingredient parser does with
 * "2 à 3 oignons" and is the same reasoning: cooking for four when six are
 * coming is the failure that cannot be fixed at the table. This took the first
 * number instead, so the two halves of the same import disagreed about what a
 * range means.
 */
export function parseYield(value: unknown): number {
  const text = firstString(value);
  if (!text) return DEFAULT_SERVINGS;

  const range = /(\d+)\s*(?:-|–|to|a|à)\s*(\d+)/i.exec(text);
  const match = range ? range[2] : /\d+/.exec(text)?.[0];
  if (match === undefined) return DEFAULT_SERVINGS;

  const parsed = Number(match);
  return parsed >= 1 && parsed <= 50 ? parsed : DEFAULT_SERVINGS;
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
