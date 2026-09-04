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
    displayName: "Ingrédient",
    aisle: null,
    quantity: null,
    unit: null,
    optional: false,
    densityGPerMl: null,
    ...overrides,
  };
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
      line({ ingredientId: "i-1", displayName: "Farine", quantity: 600, unit: "g" }),
      line({
        ingredientId: "i-1",
        displayName: "Farine",
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
      line({ ingredientId: "i-2", displayName: "Oignon", quantity: 2 }),
      line({
        ingredientId: "i-2",
        displayName: "Oignon",
        quantity: 1,
        entryId: "entry-2",
      }),
    ]);

    expect(lines[0]).toMatchObject({ quantity: 3, unit: null });
  });

  it("reads a spoon total back as spoons when nothing else was added", () => {
    // It converts so it can be summed, not so it can be displayed in millilitres.
    const lines = aggregateGroceryLines([
      line({ ingredientId: "i-3", displayName: "Huile", quantity: 1, unit: "c. à s." }),
      line({
        ingredientId: "i-3",
        displayName: "Huile",
        quantity: 2,
        unit: "c. à s.",
        entryId: "entry-2",
      }),
    ]);

    expect(lines[0]).toMatchObject({ quantity: 3, unit: "c. à s." });
  });

  it("still normalizes the metric scale even from a single unit", () => {
    const lines = aggregateGroceryLines([
      line({ ingredientId: "i-3b", displayName: "Farine", quantity: 1500, unit: "g" }),
    ]);
    expect(lines[0]).toMatchObject({ quantity: 1.5, unit: "kg" });
  });

  it("converts a tablespoon, which has an unambiguous metric definition", () => {
    const lines = aggregateGroceryLines([
      line({ ingredientId: "i-3", displayName: "Huile", quantity: 2, unit: "c. à s." }),
      line({
        ingredientId: "i-3",
        displayName: "Huile",
        quantity: 70,
        unit: "ml",
        entryId: "entry-2",
      }),
    ]);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ quantity: 100, unit: "ml" });
  });

  it("rounds a countable up, because half a courgette is not buyable", () => {
    const lines = aggregateGroceryLines([
      line({ ingredientId: "i-4", displayName: "Courgette", quantity: 1.5 }),
    ]);
    expect(lines[0]?.quantity).toBe(2);
  });
});

describe("what must never be merged", () => {
  it("keeps incompatible units apart and groups them under one heading", () => {
    const lines = aggregateGroceryLines([
      line({ ingredientId: "i-5", displayName: "Oignon", quantity: 2 }),
      line({
        ingredientId: "i-5",
        displayName: "Oignon",
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
      line({ displayName: "persil plat", quantity: 1 }),
      line({ displayName: "persil plat", quantity: 1, entryId: "entry-2" }),
    ]);

    expect(lines).toHaveLength(2);
    expect(lines.every((row) => row.unmergeableGroup === null)).toBe(true);
  });

  it("merges a volume into a mass only when the ingredient carries a density", () => {
    const withoutDensity = aggregateGroceryLines([
      line({ ingredientId: "i-6", displayName: "Miel", quantity: 100, unit: "g" }),
      line({
        ingredientId: "i-6",
        displayName: "Miel",
        quantity: 50,
        unit: "ml",
        entryId: "entry-2",
      }),
    ]);
    expect(withoutDensity).toHaveLength(2);

    const withDensity = aggregateGroceryLines([
      line({
        ingredientId: "i-6",
        displayName: "Miel",
        quantity: 100,
        unit: "g",
        densityGPerMl: 1.4,
      }),
      line({
        ingredientId: "i-6",
        displayName: "Miel",
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
      line({ ingredientId: "i-7", displayName: "Poivre", optional: true }),
      line({ ingredientId: "i-8", displayName: "Sel" }),
    ]);
    expect(lines.map((row) => [row.displayName, row.optional])).toEqual([
      ["Poivre", true],
      ["Sel", false],
    ]);
  });

  it("never adds an optional quantity into the required one", () => {
    const lines = aggregateGroceryLines([
      line({ ingredientId: "i-7", displayName: "Crème", quantity: 200, unit: "g" }),
      line({
        ingredientId: "i-7",
        displayName: "Crème",
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
    const lines = aggregateGroceryLines([
      line({ ingredientId: "i-9", displayName: "Sel" }),
    ]);
    expect(lines[0]).toMatchObject({ displayName: "Sel", quantity: null });
  });
});

describe("ordering", () => {
  it("groups by aisle and puts anything unshelved last", () => {
    const lines = aggregateGroceryLines([
      line({ ingredientId: "a", displayName: "Zucchini", aisle: "Fruits et légumes" }),
      line({ ingredientId: "b", displayName: "Beurre", aisle: "Crémerie" }),
      line({ ingredientId: "c", displayName: "Allumettes", aisle: null }),
      line({ ingredientId: "d", displayName: "Ail", aisle: "Fruits et légumes" }),
    ]);

    expect(lines.map((row) => row.displayName)).toEqual([
      "Beurre",
      "Ail",
      "Zucchini",
      "Allumettes",
    ]);
  });
});
