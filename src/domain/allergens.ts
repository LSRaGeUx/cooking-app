import { DomainError, type DomainWarning } from "./errors";
import type { AllergenSeverityValue } from "./vocabulary";

/**
 * The only hard block in the system.
 *
 * Matching is explicit, never inferred: an allergen fires when one of the terms
 * the user themselves listed appears in an ingredient. We do not guess that
 * "beurre" implies "lait", because a rule the user cannot see is a rule they
 * cannot verify, and a false negative here is a health event rather than a bad
 * dinner. The one liberty taken is a trailing plural, so "oeuf" catches
 * "oeufs" and "oeufs" catches "oeuf": a word-boundary match without it would
 * silently miss most French ingredient lines, in whichever direction the user
 * happened to type their term.
 */

/**
 * The same two values as `ALLERGEN_SEVERITIES`, and derived from it rather than
 * spelled again: this used to be a hand-written copy, so adding a severity to
 * the vocabulary would have compiled here and then failed the check constraint
 * at runtime.
 */
export type AllergenSeverity = AllergenSeverityValue;

export interface AllergenRule {
  readonly id: string;
  readonly name: string;
  readonly severity: AllergenSeverity;
  readonly matches: readonly string[];
}

export interface ExclusionRule {
  readonly id: string;
  readonly name: string;
  readonly matches: readonly string[];
}

/** Whatever text we hold about one ingredient of one recipe. */
export interface IngredientText {
  readonly rawName: string;
  readonly canonicalName?: string | null;
  readonly aliases?: readonly string[] | null;
}

export interface AllergenHit {
  readonly allergenId: string;
  readonly allergenName: string;
  readonly severity: AllergenSeverity;
  readonly ingredientName: string;
  readonly matchedTerm: string;
}

/** Lowercase, fold ligatures, strip accents, collapse separators. */
export function normalizeTerm(value: string): string {
  return (
    value
      .toLowerCase()
      // NFD leaves \u0153 and \u00e6 alone, they are letters rather than accented ones, and
      // French kitchens spell them both ways: "boeuf hach\u00e9" and "b\u0153uf hach\u00e9" are
      // the same word, and an allergen term typed either way must still fire.
      .replace(/\u0153/g, "oe")
      .replace(/\u00e6/g, "ae")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      // Apostrophes separate words in French elision ("d'ail"), so they become
      // boundaries rather than disappearing.
      .replace(/[\u2019']/g, " ")
      // Hyphens are the same case, and were the more damaging omission: the
      // regulated French allergen names are hyphenated compounds, so a user who
      // pasted "fruits \u00e0 coque" was not protected against an ingredient written
      // "fruits-\u00e0-coque", and the block is meant to have no such gap. Every dash
      // Unicode offers is folded, because a paste from a web page rarely uses
      // the plain hyphen-minus.
      .replace(/[-\u2010-\u2015\u2212]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A term with its matcher built once, so a week of recipes compiles one each. */
interface CompiledTerm {
  /** The term as the user wrote it, which is what an error message quotes. */
  readonly term: string;
  readonly pattern: RegExp;
}

/**
 * The forms of a term that are allowed to match, in both directions.
 *
 * The haystack side has always tolerated a trailing plural, so "oeuf" catches
 * "oeufs". The needle side did not, so a user who listed "oeufs" was not
 * protected against a recipe line reading "1 oeuf". Both sides now vary, by
 * stripping a trailing plural marker off the needle and letting the pattern put
 * one back.
 *
 * Terms of three characters or fewer keep their last letter, so "os", "jus" and
 * "riz" are never cut down to a fragment. Above that, stripping can widen a
 * term further than French grammar would ("noix" also admits "noi"), and that
 * is accepted deliberately: a spurious match here is a refused recipe, and a
 * missed one is a health event.
 */
function termForms(needle: string): string[] {
  if (needle.length <= 3) return [needle];
  const stem = needle.replace(/[sx]$/, "");
  return stem === needle ? [needle] : [needle, stem];
}

/**
 * Word-boundary matchers for a rule's terms. Word boundaries are what keep
 * "lait" from firing on "laitue", which is the failure mode that makes a naive
 * substring matcher unusable.
 */
function compileTerms(terms: readonly string[]): CompiledTerm[] {
  const compiled: CompiledTerm[] = [];

  for (const term of terms) {
    const needle = normalizeTerm(term);
    if (!needle) continue;
    const alternatives = termForms(needle).map(escapeRegExp).join("|");
    compiled.push({
      term,
      pattern: new RegExp(
        `(^|[^a-z0-9])(?:${alternatives})(s|x)?([^a-z0-9]|$)`,
      ),
    });
  }

  return compiled;
}

/**
 * The first of `terms` that fires against an already-normalized haystack, or
 * null. The haystack is normalized by the caller, once per ingredient, rather
 * than here: with a dozen allergens and forty ingredients the old shape
 * re-normalized the same string five hundred times.
 */
function matchTerms(
  terms: readonly CompiledTerm[],
  haystack: string,
): string | null {
  for (const { term, pattern } of terms) {
    if (pattern.test(haystack)) return term;
  }
  return null;
}

/**
 * Word-boundary match with an optional French plural on either side. Kept for
 * callers testing one term against one string; the bulk paths compile their
 * terms once instead.
 */
export function termMatches(term: string, haystack: string): boolean {
  return matchTerms(compileTerms([term]), normalizeTerm(haystack)) !== null;
}

/** An ingredient's searchable text, normalized once. */
interface PreparedIngredient {
  readonly ingredient: IngredientText;
  readonly haystack: string;
}

function prepareIngredients(
  ingredients: readonly IngredientText[],
): PreparedIngredient[] {
  return ingredients.map((ingredient) => ({
    ingredient,
    haystack: normalizeTerm(
      [
        ingredient.rawName,
        ingredient.canonicalName ?? "",
        ...(ingredient.aliases ?? []),
      ].join(" "),
    ),
  }));
}

function hitsFor(
  prepared: readonly PreparedIngredient[],
  rules: readonly AllergenRule[],
): AllergenHit[] {
  const hits: AllergenHit[] = [];

  // The allergen's own name counts as a term, so a user who typed "arachide"
  // with no aliases is still protected.
  const compiled = rules.map((rule) => ({
    rule,
    terms: compileTerms([rule.name, ...rule.matches]),
  }));

  for (const { ingredient, haystack } of prepared) {
    for (const { rule, terms } of compiled) {
      const matched = matchTerms(terms, haystack);
      if (matched === null) continue;
      hits.push({
        allergenId: rule.id,
        allergenName: rule.name,
        severity: rule.severity,
        ingredientName: ingredient.rawName,
        matchedTerm: matched,
      });
    }
  }

  return hits;
}

/**
 * Every allergen term that fires against every ingredient, both severities.
 * Callers decide what to do per severity: `strict` blocks, `avoid` warns.
 */
export function findAllergenHits(
  ingredients: readonly IngredientText[],
  rules: readonly AllergenRule[],
): AllergenHit[] {
  return hitsFor(prepareIngredients(ingredients), rules);
}

export function findStrictHits(
  ingredients: readonly IngredientText[],
  rules: readonly AllergenRule[],
): AllergenHit[] {
  return findAllergenHits(ingredients, rules).filter(
    (hit) => hit.severity === "strict",
  );
}

/**
 * The block itself. Called by every write path that puts a recipe in a slot,
 * in the service layer, so neither the UI nor MCP can route around it.
 */
export function assertNoStrictAllergen(
  recipeTitle: string,
  ingredients: readonly IngredientText[],
  rules: readonly AllergenRule[],
): void {
  const hits = findStrictHits(ingredients, rules);
  const [first] = hits;
  if (!first) return;

  throw new DomainError(
    "STRICT_ALLERGEN",
    `La recette « ${recipeTitle} » contient ${first.ingredientName}, qui correspond à l'allergène strict « ${first.allergenName} » (terme « ${first.matchedTerm} »). Un allergène strict ne peut jamais être placé dans un créneau, sans exception. Choisissez une autre recette ou retirez cet ingrédient de la recette.`,
    {
      recipeTitle,
      hits: hits.map((hit) => ({
        allergen: hit.allergenName,
        ingredient: hit.ingredientName,
        matchedTerm: hit.matchedTerm,
      })),
    },
  );
}

/** Non-blocking counterpart: `avoid` allergens and refused ingredients. */
export function collectIngredientWarnings(
  recipeTitle: string,
  ingredients: readonly IngredientText[],
  allergens: readonly AllergenRule[],
  exclusions: readonly ExclusionRule[],
): DomainWarning[] {
  const warnings: DomainWarning[] = [];
  // One normalization for both passes. The allergen pass and the exclusion pass
  // read the same text, and this used to normalize every ingredient twice.
  const prepared = prepareIngredients(ingredients);

  for (const hit of hitsFor(prepared, allergens)) {
    if (hit.severity === "strict") continue;
    warnings.push({
      code: "EXCLUDED_INGREDIENT",
      message: `« ${recipeTitle} » contient ${hit.ingredientName}, qui correspond à l'allergène « ${hit.allergenName} » à éviter.`,
      // `kind` separates the two things this one code covers: an allergen the
      // user marked "avoid", and an ingredient they simply refuse. The screen
      // words them differently; an agent gets both fields either way.
      details: {
        kind: "allergen",
        allergen: hit.allergenName,
        ingredient: hit.ingredientName,
        recipeTitle,
      },
    });
  }

  const compiledExclusions = exclusions.map((exclusion) => ({
    exclusion,
    terms: compileTerms([exclusion.name, ...exclusion.matches]),
  }));

  for (const { ingredient, haystack } of prepared) {
    for (const { exclusion, terms } of compiledExclusions) {
      if (matchTerms(terms, haystack) === null) continue;
      warnings.push({
        code: "EXCLUDED_INGREDIENT",
        message: `« ${recipeTitle} » contient ${ingredient.rawName}, un ingrédient que vous avez exclu (« ${exclusion.name} »).`,
        details: {
          kind: "exclusion",
          exclusion: exclusion.name,
          ingredient: ingredient.rawName,
          recipeTitle,
        },
      });
    }
  }

  return warnings;
}
