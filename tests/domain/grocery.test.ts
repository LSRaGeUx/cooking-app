import { describe, expect, it } from "vitest";
import {
  aggregateGroceryLines,
  scaleQuantity,
  type GrocerySourceLine,
} from "@/domain/grocery";

function line(overrides: Partial<GrocerySourceLine>): GrocerySourceLine {
  return {
    entryId: "entry-1",
    ingredientId: null,
    rawName: "Ingrédient",
    canonicalName: null,
    aisle: null,
    quantity: null,
    unit: null,
    optional: false,
    densityGPerMl: null,
    ...overrides,
  };
}

/** A line written exactly the way its linked ingredient is named. */
function linked(
  ingredientId: string,
  name: string,
  overrides: Partial<GrocerySourceLine> = {},
): GrocerySourceLine {
  return line({
    ingredientId,
    rawName: name,
    canonicalName: name,
    ...overrides,
  });
}

describe("scaling a recipe to the servings a slot asks for", () => {
  it("scales up and down", () => {
    expect(scaleQuantity(200, 4, 2)).toBe(100);
    expect(scaleQuantity(200, 2, 5)).toBe(500);
  });

  it("leaves an unspecified quantity alone", () => {
    expect(scaleQuantity(null, 4, 2)).toBeNull();
  });

  it("does not divide by a missing serving count", () => {
    expect(scaleQuantity(200, 0, 4)).toBe(200);
  });
});

describe("merging within one dimension", () => {
  it("sums two masses and reads the total back in a human unit", () => {
    const lines = aggregateGroceryLines([
      linked("i-1", "Farine", { quantity: 600, unit: "g" }),
      linked("i-1", "Farine", {
        quantity: 0.7,
        unit: "kg",
        entryId: "entry-2",
      }),
    ]);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ quantity: 1.3, unit: "kg" });
    expect(lines[0]!.sourceEntryIds.sort()).toEqual(["entry-1", "entry-2"]);
  });

  it("keeps a shared unit rather than converting for no reason", () => {
    const lines = aggregateGroceryLines([
      linked("i-2", "Oignon", { quantity: 2 }),
      linked("i-2", "Oignon", { quantity: 1, entryId: "entry-2" }),
    ]);

    expect(lines[0]).toMatchObject({ quantity: 3, unit: null });
  });

  it("reads a spoon total back as spoons when nothing else was added", () => {
    // It converts so it can be summed, not so it can be displayed in millilitres.
    const lines = aggregateGroceryLines([
      linked("i-3", "Huile", { quantity: 1, unit: "c. à s." }),
      linked("i-3", "Huile", {
        quantity: 2,
        unit: "c. à s.",
        entryId: "entry-2",
      }),
    ]);

    expect(lines[0]).toMatchObject({ quantity: 3, unit: "c. à s." });
  });

  it("still normalizes the metric scale even from a single unit", () => {
    const lines = aggregateGroceryLines([
      linked("i-3b", "Farine", { quantity: 1500, unit: "g" }),
    ]);
    expect(lines[0]).toMatchObject({ quantity: 1.5, unit: "kg" });
  });

  it("converts a tablespoon, which has an unambiguous metric definition", () => {
    const lines = aggregateGroceryLines([
      linked("i-3", "Huile", { quantity: 2, unit: "c. à s." }),
      linked("i-3", "Huile", { quantity: 70, unit: "ml", entryId: "entry-2" }),
    ]);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ quantity: 100, unit: "ml" });
  });

  it("rounds a countable up, because half a courgette is not buyable", () => {
    const lines = aggregateGroceryLines([
      linked("i-4", "Courgette", { quantity: 1.5 }),
    ]);
    expect(lines[0]?.quantity).toBe(2);
  });
});

describe("naming the product to buy", () => {
  /**
   * The failure this pins down: a coulis links to Tomate for its aisle and its
   * allergens, and a list that reads "Tomate" sends the cook to the wrong
   * shelf. The link still has to earn its keep, so two coulis still add up.
   */
  it("keeps a narrower product under the name it was written with", () => {
    const lines = aggregateGroceryLines([
      line({
        ingredientId: "i-tomate",
        rawName: "coulis de tomate",
        canonicalName: "Tomate",
        aisle: "Épicerie salée",
        quantity: 250,
        unit: "ml",
      }),
      line({
        ingredientId: "i-tomate",
        rawName: "coulis de tomate",
        canonicalName: "Tomate",
        aisle: "Épicerie salée",
        quantity: 250,
        unit: "ml",
        entryId: "entry-2",
      }),
    ]);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      displayName: "coulis de tomate",
      quantity: 500,
      unit: "ml",
      productVariant: true,
      // The link is not thrown away: the aisle still comes from it.
      aisle: "Épicerie salée",
    });
    expect(lines[0]!.sourceEntryIds.sort()).toEqual(["entry-1", "entry-2"]);
  });

  it("never pours two different products into one ingredient", () => {
    const lines = aggregateGroceryLines([
      line({
        ingredientId: "i-pain",
        rawName: "pain de mie",
        canonicalName: "Pain",
        quantity: 1,
      }),
      line({
        ingredientId: "i-pain",
        rawName: "pain à burger",
        canonicalName: "Pain",
        quantity: 4,
        entryId: "entry-2",
      }),
    ]);

    expect(lines.map((row) => [row.displayName, row.quantity])).toEqual([
      ["pain à burger", 4],
      ["pain de mie", 1],
    ]);
    // Two products, not one ingredient in two units: nothing to group under a
    // shared heading.
    expect(lines.every((row) => row.unmergeableGroup === null)).toBe(true);
  });

  it("merges the ingredient's own name however it was spelled", () => {
    // Case, accents, a plural and the œ ligature are one word, not two
    // products, so these add up and read back canonical.
    const lines = aggregateGroceryLines([
      line({
        ingredientId: "i-oeuf",
        rawName: "oeufs",
        canonicalName: "Œuf",
        quantity: 2,
      }),
      line({
        ingredientId: "i-oeuf",
        rawName: "ŒUF",
        canonicalName: "Œuf",
        quantity: 1,
        entryId: "entry-2",
      }),
    ]);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      displayName: "Œuf",
      quantity: 3,
      productVariant: false,
    });
  });

  /**
   * The alias is why the line has an aisle and an allergen set at all, and it
   * is still no evidence that a shopper buys the same thing: "spaghetti"
   * resolves to `Pâtes` and is not pasta in general.
   */
  it("does not let an alias rename the line, only link it", () => {
    const lines = aggregateGroceryLines([
      line({
        ingredientId: "i-pates",
        rawName: "spaghetti",
        canonicalName: "Pâtes",
        aisle: "Épicerie salée",
        quantity: 250,
        unit: "g",
      }),
      line({
        ingredientId: "i-pates",
        rawName: "spaghettis",
        canonicalName: "Pâtes",
        aisle: "Épicerie salée",
        quantity: 250,
        unit: "g",
        entryId: "entry-2",
      }),
      line({
        ingredientId: "i-pates",
        rawName: "penne",
        canonicalName: "Pâtes",
        aisle: "Épicerie salée",
        quantity: 300,
        unit: "g",
        entryId: "entry-3",
      }),
    ]);

    // The two spellings of one shape add up; the other shape does not join it.
    expect(
      lines.map((row) => [row.displayName, row.quantity, row.productVariant]),
    ).toEqual([
      ["penne", 300, true],
      ["spaghetti", 500, true],
    ]);
    expect(lines.every((row) => row.aisle === "Épicerie salée")).toBe(true);
  });

  it("does not split one product over a plural", () => {
    const lines = aggregateGroceryLines([
      line({
        ingredientId: "i-tomate",
        rawName: "coulis de tomate",
        canonicalName: "Tomate",
        quantity: 200,
        unit: "ml",
      }),
      line({
        ingredientId: "i-tomate",
        rawName: "Coulis de tomates",
        canonicalName: "Tomate",
        quantity: 300,
        unit: "ml",
        entryId: "entry-2",
      }),
    ]);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      displayName: "coulis de tomate",
      quantity: 500,
      unit: "ml",
    });
  });

  it("falls back to the written name when nothing was linked", () => {
    const lines = aggregateGroceryLines([
      line({ rawName: "pain de mie", quantity: 1 }),
    ]);
    expect(lines[0]).toMatchObject({
      displayName: "pain de mie",
      productVariant: false,
    });
  });
});

describe("what must never be merged", () => {
  it("keeps incompatible units apart and groups them under one heading", () => {
    const lines = aggregateGroceryLines([
      linked("i-5", "Oignon", { quantity: 2 }),
      linked("i-5", "Oignon", {
        quantity: 300,
        unit: "g",
        entryId: "entry-2",
      }),
    ]);

    expect(lines).toHaveLength(2);
    // Both carry the same group, so the screen can show one heading with two
    // lines rather than inventing a conversion.
    expect(new Set(lines.map((row) => row.unmergeableGroup))).toEqual(
      new Set(["i-5"]),
    );
  });

  it("never merges unlinked lines, because two spellings are not evidence", () => {
    const lines = aggregateGroceryLines([
      line({ rawName: "persil plat", quantity: 1 }),
      line({ rawName: "persil plat", quantity: 1, entryId: "entry-2" }),
    ]);

    expect(lines).toHaveLength(2);
    expect(lines.every((row) => row.unmergeableGroup === null)).toBe(true);
  });

  it("merges a volume into a mass only when the ingredient carries a density", () => {
    const withoutDensity = aggregateGroceryLines([
      linked("i-6", "Miel", { quantity: 100, unit: "g" }),
      linked("i-6", "Miel", { quantity: 50, unit: "ml", entryId: "entry-2" }),
    ]);
    expect(withoutDensity).toHaveLength(2);

    const withDensity = aggregateGroceryLines([
      linked("i-6", "Miel", {
        quantity: 100,
        unit: "g",
        densityGPerMl: 1.4,
      }),
      linked("i-6", "Miel", {
        quantity: 50,
        unit: "ml",
        densityGPerMl: 1.4,
        entryId: "entry-2",
      }),
    ]);
    expect(withDensity).toHaveLength(1);
    expect(withDensity[0]).toMatchObject({ quantity: 170, unit: "g" });
  });
});

describe("optional ingredients and unspecified quantities", () => {
  it("carries optional ingredients out with the flag, rather than dropping them", () => {
    const lines = aggregateGroceryLines([
      linked("i-7", "Poivre", { optional: true }),
      linked("i-8", "Sel"),
    ]);
    expect(lines.map((row) => [row.displayName, row.optional])).toEqual([
      ["Poivre", true],
      ["Sel", false],
    ]);
  });

  it("never adds an optional quantity into the required one", () => {
    const lines = aggregateGroceryLines([
      linked("i-7", "Crème", { quantity: 200, unit: "g" }),
      linked("i-7", "Crème", {
        quantity: 50,
        unit: "g",
        optional: true,
        entryId: "entry-2",
      }),
    ]);

    // Two lines, in two sections of the screen, and neither is grouped with
    // the other as an unmergeable pair: they are simply not the same shopping.
    expect(lines).toHaveLength(2);
    expect(lines.map((row) => [row.quantity, row.optional])).toEqual([
      [200, false],
      [50, true],
    ]);
    expect(lines.every((row) => row.unmergeableGroup === null)).toBe(true);
  });

  it("keeps an ingredient with no quantity as a bare name", () => {
    const lines = aggregateGroceryLines([linked("i-9", "Sel")]);
    expect(lines[0]).toMatchObject({ displayName: "Sel", quantity: null });
  });
});

describe("ordering", () => {
  it("groups by aisle and puts anything unshelved last", () => {
    const lines = aggregateGroceryLines([
      linked("a", "Zucchini", { aisle: "Fruits et légumes" }),
      linked("b", "Beurre", { aisle: "Crémerie" }),
      linked("c", "Allumettes"),
      linked("d", "Ail", { aisle: "Fruits et légumes" }),
    ]);

    expect(lines.map((row) => row.displayName)).toEqual([
      "Beurre",
      "Ail",
      "Zucchini",
      "Allumettes",
    ]);
  });
});
