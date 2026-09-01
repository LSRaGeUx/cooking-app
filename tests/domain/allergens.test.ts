import { describe, expect, it } from "vitest";
import {
  assertNoStrictAllergen,
  collectIngredientWarnings,
  findStrictHits,
  termMatches,
  type AllergenRule,
} from "@/domain/allergens";
import { DomainError } from "@/domain/errors";

const milk: AllergenRule = {
  id: "allergen-milk",
  name: "Lait",
  severity: "strict",
  matches: ["lait", "beurre", "crème", "fromage"],
};

const nuts: AllergenRule = {
  id: "allergen-nuts",
  name: "Fruits à coque",
  severity: "avoid",
  matches: ["noix", "amande", "noisette"],
};

describe("allergen term matching", () => {
  it("matches on whole words, accents folded", () => {
    expect(termMatches("crème", "20 cl de creme fraiche")).toBe(true);
    expect(termMatches("creme", "20 cl de crème fraîche")).toBe(true);
  });

  it("tolerates a French plural", () => {
    expect(termMatches("oeuf", "3 oeufs")).toBe(true);
    expect(termMatches("noix", "des noix")).toBe(true);
  });

  it("does not fire on a longer word that merely contains the term", () => {
    // The failure mode that makes a substring matcher unusable: a salad is not
    // a dairy product.
    expect(termMatches("lait", "une laitue")).toBe(false);
    expect(termMatches("ail", "du travail")).toBe(false);
  });

  it("treats elision as a word boundary", () => {
    expect(termMatches("ail", "2 gousses d'ail")).toBe(true);
  });
});

describe("strict allergen block", () => {
  const ingredients = [
    { rawName: "200 g de beurre doux" },
    { rawName: "1 laitue" },
  ];

  it("finds the strict hit and names what matched", () => {
    const hits = findStrictHits(ingredients, [milk, nuts]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      allergenName: "Lait",
      matchedTerm: "beurre",
    });
  });

  it("throws STRICT_ALLERGEN with an actionable message", () => {
    let thrown: unknown;
    try {
      assertNoStrictAllergen("Gratin dauphinois", ingredients, [milk]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(DomainError);
    const error = thrown as DomainError;
    expect(error.code).toBe("STRICT_ALLERGEN");
    // The message must name the recipe, the ingredient and the allergen, or an
    // agent cannot fix its own proposal without asking a human.
    expect(error.message).toContain("Gratin dauphinois");
    expect(error.message).toContain("beurre");
    expect(error.message).toContain("Lait");
    expect(error.details.hits).toHaveLength(1);
  });

  it("passes a recipe with no strict match", () => {
    expect(() =>
      assertNoStrictAllergen("Salade verte", [{ rawName: "1 laitue" }], [milk]),
    ).not.toThrow();
  });

  it("never blocks on an avoid-severity allergen", () => {
    expect(() =>
      assertNoStrictAllergen(
        "Tarte aux noix",
        [{ rawName: "150 g de noix" }],
        [nuts],
      ),
    ).not.toThrow();
  });

  it("matches through a linked ingredient's aliases", () => {
    const hits = findStrictHits(
      [{ rawName: "20 cl de fleurette", aliases: ["crème liquide"] }],
      [milk],
    );
    expect(hits).toHaveLength(1);
  });
});

describe("non-blocking ingredient warnings", () => {
  it("warns for an avoid allergen and for an exclusion", () => {
    const warnings = collectIngredientWarnings(
      "Tarte aux noix",
      [{ rawName: "150 g de noix" }, { rawName: "1 botte de coriandre" }],
      [nuts],
      [{ id: "x", name: "Coriandre", matches: ["coriandre"] }],
    );

    expect(warnings).toHaveLength(2);
    expect(warnings.every((w) => w.code === "EXCLUDED_INGREDIENT")).toBe(true);
  });

  it("does not warn twice for a strict allergen already blocked", () => {
    const warnings = collectIngredientWarnings(
      "Gratin",
      [{ rawName: "200 g de beurre" }],
      [milk],
      [],
    );
    expect(warnings).toHaveLength(0);
  });
});
