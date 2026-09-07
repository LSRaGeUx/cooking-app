import { describe, expect, it } from "vitest";
import {
  parseIngredientBlock,
  parseIngredientLine,
} from "@/domain/ingredient-parser";

describe("ingredient paste parser", () => {
  it("reads quantity, unit and name", () => {
    expect(parseIngredientLine("200 g de farine")).toMatchObject({
      quantity: 200,
      unit: "g",
      rawName: "farine",
    });
  });

  it("handles a unit stuck to its number", () => {
    expect(parseIngredientLine("150ml de lait")).toMatchObject({
      quantity: 150,
      unit: "ml",
      rawName: "lait",
    });
  });

  it("reads a French decimal comma as a decimal, not as a note", () => {
    // The note split ran before the quantity was extracted, so this line came
    // out with no quantity, no unit, a name of "1" and a note of
    // "5 kg de farine". A comma with a digit on both sides is a decimal point.
    expect(parseIngredientLine("1,5 kg de farine")).toMatchObject({
      quantity: 1.5,
      unit: "kg",
      rawName: "farine",
      note: null,
    });
    // And a comma that separates clauses still introduces a note, even when
    // the line also carries a decimal.
    expect(parseIngredientLine("1,5 kg de farine, tamisée")).toMatchObject({
      quantity: 1.5,
      unit: "kg",
      rawName: "farine",
      note: "tamisée",
    });
  });

  it("reads a French thousands separator as one number", () => {
    // "1 000 g" parsed as a quantity of 1 with "000 g de farine" as the name.
    expect(parseIngredientLine("1 000 g de farine")).toMatchObject({
      quantity: 1000,
      unit: "g",
      rawName: "farine",
    });
    // A non-breaking space is what a word processor and most web pages emit.
    expect(parseIngredientLine("1 000 g de farine")).toMatchObject({
      quantity: 1000,
      unit: "g",
      rawName: "farine",
    });
    // Two separate numbers are still two: the group has to be three digits.
    expect(parseIngredientLine("1 5 kg de farine")).toMatchObject({
      quantity: 1,
      rawName: "5 kg de farine",
    });
  });

  it("recognizes pièces, the commonest French countable unit", () => {
    // With no alias for it the unit went unrecognized, the connector was never
    // stripped, and the whole tail became the name.
    expect(parseIngredientLine("3 pièces de poulet")).toMatchObject({
      quantity: 3,
      unit: "morceau",
      rawName: "poulet",
    });
    expect(parseIngredientLine("1 pièce de boeuf")).toMatchObject({
      quantity: 1,
      unit: "morceau",
      rawName: "boeuf",
    });
  });

  it("leaves a countable ingredient without a unit", () => {
    expect(parseIngredientLine("2 oignons")).toMatchObject({
      quantity: 2,
      unit: null,
      rawName: "oignons",
    });
  });

  it("understands abbreviated spoon measures", () => {
    expect(parseIngredientLine("1 c. à s. d'huile d'olive")).toMatchObject({
      quantity: 1,
      unit: "c. à s.",
      rawName: "huile d'olive",
    });
    expect(parseIngredientLine("2 cuillères à café de curry")).toMatchObject({
      quantity: 2,
      unit: "c. à c.",
      rawName: "curry",
    });
  });

  it("takes the upper bound of a range", () => {
    // Buying too little ends the cooking session; buying too much ends a
    // leftover.
    expect(parseIngredientLine("2-3 carottes")).toMatchObject({
      quantity: 3,
      rawName: "carottes",
    });
    expect(parseIngredientLine("2 à 3 carottes")).toMatchObject({
      quantity: 3,
    });
  });

  it("reads fractions in every form they get pasted in", () => {
    expect(parseIngredientLine("1/2 citron").quantity).toBe(0.5);
    expect(parseIngredientLine("½ citron").quantity).toBe(0.5);
    expect(parseIngredientLine("1 1/2 tasse de riz")).toMatchObject({
      quantity: 1.5,
      unit: "tasse",
      rawName: "riz",
    });
  });

  it("splits a trailing comma into a note", () => {
    expect(parseIngredientLine("3 gousses d'ail, écrasées")).toMatchObject({
      quantity: 3,
      unit: "gousse",
      rawName: "ail",
      note: "écrasées",
    });
  });

  it("detects an optional ingredient", () => {
    expect(parseIngredientLine("poivre du moulin (optionnel)")).toMatchObject({
      optional: true,
      rawName: "poivre du moulin",
    });
    expect(parseIngredientLine("sel").optional).toBe(false);
  });

  it("keeps a bare ingredient as its own name", () => {
    expect(parseIngredientLine("sel")).toMatchObject({
      quantity: null,
      unit: null,
      rawName: "sel",
    });
  });

  it("never loses the line, even when it cannot parse it", () => {
    const parsed = parseIngredientLine("quelques feuilles de basilic frais");
    expect(parsed.rawName.length).toBeGreaterThan(0);
    expect(parsed.original).toBe("quelques feuilles de basilic frais");
  });

  it("does not read an elided article as a litre", () => {
    expect(parseIngredientLine("1 gousse d'ail")).toMatchObject({
      unit: "gousse",
      rawName: "ail",
    });
  });

  it("parses a pasted block, dropping bullets and blank lines", () => {
    const lines = parseIngredientBlock(
      [
        "- 100 g de beurre",
        "",
        "• 2 œufs",
        "  1 boîte de tomates concassées  ",
      ].join("\n"),
    );

    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({
      quantity: 100,
      unit: "g",
      rawName: "beurre",
    });
    expect(lines[1]).toMatchObject({ quantity: 2, rawName: "œufs" });
    expect(lines[2]).toMatchObject({
      quantity: 1,
      unit: "boîte",
      rawName: "tomates concassées",
    });
  });
});
