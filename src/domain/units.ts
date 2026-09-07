import { CANONICAL_UNITS } from "./ingredient-parser";

/**
 * Unit conversion for grocery merging.
 *
 * The rule that shapes this file: only units with an unambiguous metric
 * definition convert. Grams, litres and their prefixes convert because they are
 * defined; a French tablespoon converts because it is 15 ml by convention. A
 * "tasse" or a "verre" does not, because it is 200 ml in one kitchen and 250 in
 * another, and inventing the difference is exactly the guessing the spec
 * forbids. Anything that does not convert is counted in its own right and shown
 * as its own line.
 */

export type UnitDimension = "mass" | "volume" | "count";

interface UnitDefinition {
  readonly dimension: UnitDimension;
  /** How many base units (g for mass, ml for volume) one of these is. */
  readonly toBase: number;
}

/**
 * Every key is a `CANONICAL_UNITS` constant, never the literal it happens to
 * expand to. Seven of these used to be spelled out as `mg`, `g`, `kg` and so
 * on beside two that were not, so renaming a canonical unit would have
 * desynchronised the two halves of one table and silently stopped those units
 * converting.
 */
const DEFINITIONS: Readonly<Record<string, UnitDefinition>> = {
  [CANONICAL_UNITS.MG]: { dimension: "mass", toBase: 0.001 },
  [CANONICAL_UNITS.G]: { dimension: "mass", toBase: 1 },
  [CANONICAL_UNITS.KG]: { dimension: "mass", toBase: 1000 },
  [CANONICAL_UNITS.ML]: { dimension: "volume", toBase: 1 },
  [CANONICAL_UNITS.CL]: { dimension: "volume", toBase: 10 },
  [CANONICAL_UNITS.DL]: { dimension: "volume", toBase: 100 },
  [CANONICAL_UNITS.L]: { dimension: "volume", toBase: 1000 },
  // Defined by convention in French cooking, and unambiguous enough to sum.
  [CANONICAL_UNITS.TABLESPOON]: { dimension: "volume", toBase: 15 },
  [CANONICAL_UNITS.TEASPOON]: { dimension: "volume", toBase: 5 },
};

/** Every unit this application chose the spelling of, and so can inflect. */
const CANONICAL_UNIT_SET: ReadonlySet<string> = new Set<string>(
  Object.values(CANONICAL_UNITS),
);

/**
 * Units that convert for arithmetic but should still be read back as
 * themselves. A recipe asking for one tablespoon of oil must not turn into
 * "15 ml" on the shopping list: it converts only so it can be added to other
 * volumes, and when nothing else was added there is nothing to convert for.
 * Metric scale units are the opposite case, and always normalize, because
 * "1,5 kg" is what a shopper wants to read instead of "1500 g".
 */
const PREFER_SOURCE_UNIT: ReadonlySet<string> = new Set([
  CANONICAL_UNITS.TABLESPOON,
  CANONICAL_UNITS.TEASPOON,
]);

export function prefersSourceUnit(unit: string | null): boolean {
  return unit !== null && PREFER_SOURCE_UNIT.has(unit);
}

/** The unit a countable line with no unit at all is counted in. */
export const UNITLESS = "";

export function unitDimension(unit: string | null): UnitDimension {
  if (unit === null) return "count";
  return DEFINITIONS[unit]?.dimension ?? "count";
}

export function isConvertible(unit: string | null): boolean {
  return unit !== null && unit in DEFINITIONS;
}

/** Base units: grams for mass, millilitres for volume. */
export function toBaseQuantity(
  quantity: number,
  unit: string | null,
): number | null {
  if (unit === null) return null;
  const definition = DEFINITIONS[unit];
  return definition ? quantity * definition.toBase : null;
}

export function fromBaseQuantity(
  baseQuantity: number,
  unit: string,
): number | null {
  const definition = DEFINITIONS[unit];
  return definition ? baseQuantity / definition.toBase : null;
}

/**
 * Turns a base quantity into the unit a human would write it in: 1500 g reads
 * as 1,5 kg and 0,4 g reads as 400 mg. Numbers stay at two decimals, which is
 * finer than any shop sells anything.
 */
export function normalizeBaseQuantity(
  baseQuantity: number,
  dimension: "mass" | "volume",
): { quantity: number; unit: string } {
  if (dimension === "mass") {
    if (baseQuantity >= 1000) {
      return { quantity: round(baseQuantity / 1000), unit: CANONICAL_UNITS.KG };
    }
    if (baseQuantity < 1 && baseQuantity > 0) {
      return { quantity: round(baseQuantity * 1000), unit: CANONICAL_UNITS.MG };
    }
    return { quantity: round(baseQuantity), unit: CANONICAL_UNITS.G };
  }

  if (baseQuantity >= 1000) {
    return { quantity: round(baseQuantity / 1000), unit: CANONICAL_UNITS.L };
  }
  return { quantity: round(baseQuantity), unit: CANONICAL_UNITS.ML };
}

/**
 * A countable quantity is rounded up: you cannot buy 1,5 courgette, and
 * rounding down is the one direction that ends a cooking session early.
 */
export function roundCountable(quantity: number): number {
  return Math.ceil(round(quantity));
}

export function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * French plurals for the countable units, because "3 gousse ail" is the kind of
 * detail that makes a list look machine-written. Metric symbols and the
 * abbreviated spoons never take a plural.
 */
const IRREGULAR_PLURALS: Readonly<Record<string, string>> = {
  [CANONICAL_UNITS.PIECE]: "morceaux",
};

/**
 * Only a unit this application chose the spelling of gets an `s` appended.
 *
 * A recipe may carry any unit string it likes: the parser keeps an unrecognized
 * one as written, and `recipeIngredientInputSchema.unit` accepts it. Inflecting
 * one of those was guessing about a word we did not choose, and it guessed
 * wrong in the obvious case, rendering a raw "cups" as "cupss". An unknown unit
 * is now returned untouched, which is the only honest option: we do not know
 * its language, let alone its plural.
 */
export function pluralizeUnit(
  unit: string | null,
  quantity: number | null,
): string | null {
  if (unit === null) return null;
  if (quantity === null || quantity < 2) return unit;
  if (unit in DEFINITIONS) return unit;
  const irregular = IRREGULAR_PLURALS[unit];
  if (irregular !== undefined) return irregular;
  if (!CANONICAL_UNIT_SET.has(unit)) return unit;
  return `${unit}s`;
}

/**
 * Volume to mass, and only when the user's own ingredient record carries a
 * density. Without one there is no honest conversion, so the two lines stay
 * apart.
 */
export function volumeToMass(
  millilitres: number,
  densityGPerMl: number | null,
): number | null {
  if (densityGPerMl === null || densityGPerMl <= 0) return null;
  return millilitres * densityGPerMl;
}
