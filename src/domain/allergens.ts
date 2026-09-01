import { DomainError, type DomainWarning } from "./errors";

/**
 * The only hard block in the system.
 *
 * Matching is explicit, never inferred: an allergen fires when one of the terms
 * the user themselves listed appears in an ingredient. We do not guess that
 * "beurre" implies "lait", because a rule the user cannot see is a rule they
 * cannot verify, and a false negative here is a health event rather than a bad
 * dinner. The one liberty taken is a trailing plural, so "oeuf" catches
 * "oeufs": a word-boundary match without it would silently miss most French
 * ingredient lines.
 */

export type AllergenSeverity = "avoid" | "strict";

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

/** Lowercase, strip accents, collapse whitespace. */
export function normalizeTerm(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    // Apostrophes separate words in French elision ("d'ail"), so they become
    // boundaries rather than disappearing.
    .replace(/[\u2019']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Word-boundary match with an optional French plural. Word boundaries are what
 * keep "lait" from firing on "laitue", which is the failure mode that makes a
 * naive substring matcher unusable.
 */
export function termMatches(term: string, haystack: string): boolean {
  const needle = normalizeTerm(term);
  if (!needle) return false;
  const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(needle)}(s|x)?([^a-z0-9]|$)`);
  return pattern.test(normalizeTerm(haystack));
}

function ingredientHaystack(ingredient: IngredientText): string {
  return [
    ingredient.rawName,
    ingredient.canonicalName ?? "",
    ...(ingredient.aliases ?? []),
  ].join(" ");
}

/**
 * Every allergen term that fires against every ingredient, both severities.
 * Callers decide what to do per severity: `strict` blocks, `avoid` warns.
 */
export function findAllergenHits(
  ingredients: readonly IngredientText[],
  rules: readonly AllergenRule[],
): AllergenHit[] {
  const hits: AllergenHit[] = [];

  for (const ingredient of ingredients) {
    const haystack = ingredientHaystack(ingredient);
    for (const rule of rules) {
      // The allergen's own name counts as a term, so a user who typed
      // "arachide" with no aliases is still protected.
      const terms = [rule.name, ...rule.matches];
      const matched = terms.find((term) => termMatches(term, haystack));
      if (matched) {
        hits.push({
          allergenId: rule.id,
          allergenName: rule.name,
          severity: rule.severity,
          ingredientName: ingredient.rawName,
          matchedTerm: matched,
        });
      }
    }
  }

  return hits;
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
  if (hits.length === 0) return;

  const first = hits[0]!;
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

  for (const hit of findAllergenHits(ingredients, allergens)) {
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

  for (const ingredient of ingredients) {
    const haystack = ingredientHaystack(ingredient);
    for (const exclusion of exclusions) {
      const terms = [exclusion.name, ...exclusion.matches];
      const matched = terms.find((term) => termMatches(term, haystack));
      if (!matched) continue;
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
