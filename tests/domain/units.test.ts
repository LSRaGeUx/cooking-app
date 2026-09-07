import { describe, expect, it } from "vitest";
import {
  isConvertible,
  normalizeBaseQuantity,
  pluralizeUnit,
  roundCountable,
  toBaseQuantity,
  unitDimension,
  volumeToMass,
} from "@/domain/units";

describe("which units convert at all", () => {
  it("converts the metric scale and the defined spoons", () => {
    expect(isConvertible("kg")).toBe(true);
    expect(isConvertible("cl")).toBe(true);
    expect(isConvertible("c. à s.")).toBe(true);
  });

  it("refuses units whose size depends on the kitchen", () => {
    // A "tasse" is 200 ml in one house and 250 in another, and inventing the
    // difference is the guessing the spec forbids.
    expect(isConvertible("tasse")).toBe(false);
    expect(isConvertible("verre")).toBe(false);
    expect(isConvertible("pincée")).toBe(false);
    expect(isConvertible(null)).toBe(false);
  });

  it("treats anything unconvertible as a countable", () => {
    expect(unitDimension("gousse")).toBe("count");
    expect(unitDimension(null)).toBe("count");
    expect(unitDimension("g")).toBe("mass");
    expect(unitDimension("c. à c.")).toBe("volume");
  });
});

describe("base conversion", () => {
  it("uses grams and millilitres as the base", () => {
    expect(toBaseQuantity(2, "kg")).toBe(2000);
    expect(toBaseQuantity(3, "cl")).toBe(30);
    expect(toBaseQuantity(2, "c. à s.")).toBe(30);
  });

  it("returns nothing for a unit it cannot place", () => {
    expect(toBaseQuantity(2, "tasse")).toBeNull();
    expect(toBaseQuantity(2, null)).toBeNull();
  });
});

describe("reading a quantity back", () => {
  it("moves up the scale when the number gets big", () => {
    expect(normalizeBaseQuantity(1500, "mass")).toEqual({
      quantity: 1.5,
      unit: "kg",
    });
    expect(normalizeBaseQuantity(1200, "volume")).toEqual({
      quantity: 1.2,
      unit: "l",
    });
  });

  it("moves down the scale when the number gets small", () => {
    expect(normalizeBaseQuantity(0.5, "mass")).toEqual({
      quantity: 500,
      unit: "mg",
    });
  });

  it("rounds a countable up, never down", () => {
    expect(roundCountable(1.1)).toBe(2);
    expect(roundCountable(2)).toBe(2);
  });
});

describe("volume to mass", () => {
  it("needs a density and refuses to invent one", () => {
    expect(volumeToMass(100, 1.03)).toBe(103);
    expect(volumeToMass(100, null)).toBeNull();
    expect(volumeToMass(100, 0)).toBeNull();
  });
});

describe("French plurals", () => {
  it("pluralizes countable units above one", () => {
    expect(pluralizeUnit("gousse", 3)).toBe("gousses");
    expect(pluralizeUnit("gousse", 1)).toBe("gousse");
    expect(pluralizeUnit("morceau", 4)).toBe("morceaux");
  });

  it("leaves symbols and abbreviations alone", () => {
    expect(pluralizeUnit("g", 300)).toBe("g");
    expect(pluralizeUnit("c. à s.", 3)).toBe("c. à s.");
    expect(pluralizeUnit(null, 3)).toBeNull();
  });
});
