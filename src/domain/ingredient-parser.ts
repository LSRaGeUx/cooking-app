import { normalizeTerm } from "./allergens";

/**
 * The paste parser. Its only job is to turn a block of ingredient lines copied
 * from anywhere into editable rows fast enough that saving a recipe takes under
 * a minute, because creation speed is what fills the library.
 *
 * It is explicitly a first draft, not an authority: every field it produces is
 * shown in an editable form before the recipe is saved. That framing is what
 * lets it use cheap heuristics (a comma introduces a note, a range takes its
 * upper bound) instead of trying to be right about French cooking prose.
 *
 * Pure and I/O-free, so linking a parsed line to a normalized ingredient row is
 * the service layer's job, not this file's.
 */

export interface ParsedIngredientLine {
  readonly quantity: number | null;
  /** Canonical unit token, or null when the line names no unit. */
  readonly unit: string | null;
  readonly rawName: string;
  readonly note: string | null;
  readonly optional: boolean;
  /** The input line, kept so a bad parse is diagnosable from the row itself. */
  readonly original: string;
}

/**
 * Canonical units. French forms are canonical because the UI is French; the
 * metric symbols are the ones grocery merging can convert between (phase 2),
 * and the countable ones deliberately cannot be converted at all.
 */
export const CANONICAL_UNITS = {
  MG: "mg",
  G: "g",
  KG: "kg",
  ML: "ml",
  CL: "cl",
  DL: "dl",
  L: "l",
  TABLESPOON: "c. à s.",
  TEASPOON: "c. à c.",
  PINCH: "pincée",
  CLOVE: "gousse",
  SLICE: "tranche",
  SACHET: "sachet",
  TIN: "boîte",
  JAR: "pot",
  BUNCH: "botte",
  SPRIG: "brin",
  LEAF: "feuille",
  CUP: "tasse",
  GLASS: "verre",
  HANDFUL: "poignée",
  PIECE: "morceau",
} as const;

export type CanonicalUnit = (typeof CANONICAL_UNITS)[keyof typeof CANONICAL_UNITS];

/** Mass and volume units, the ones that can be summed after conversion. */
export const CONVERTIBLE_UNITS: readonly string[] = [
  CANONICAL_UNITS.MG,
  CANONICAL_UNITS.G,
  CANONICAL_UNITS.KG,
  CANONICAL_UNITS.ML,
  CANONICAL_UNITS.CL,
  CANONICAL_UNITS.DL,
  CANONICAL_UNITS.L,
];

const UNIT_ALIASES: ReadonlyArray<readonly [string, readonly string[]]> = [
  [CANONICAL_UNITS.MG, ["mg", "milligramme", "milligrammes"]],
  [CANONICAL_UNITS.G, ["g", "gr", "gramme", "grammes"]],
  [CANONICAL_UNITS.KG, ["kg", "kilo", "kilos", "kilogramme", "kilogrammes"]],
  [CANONICAL_UNITS.ML, ["ml", "millilitre", "millilitres"]],
  [CANONICAL_UNITS.CL, ["cl", "centilitre", "centilitres"]],
  [CANONICAL_UNITS.DL, ["dl", "decilitre", "decilitres"]],
  [CANONICAL_UNITS.L, ["l", "litre", "litres"]],
  [
    CANONICAL_UNITS.TABLESPOON,
    [
      "c a s",
      "c as",
      "cas",
      "cs",
      "c a soupe",
      "cuillere a soupe",
      "cuilleres a soupe",
      "cuillere a soupe rase",
      "tbsp",
      "cuil a soupe",
      "cuil a s",
    ],
  ],
  [
    CANONICAL_UNITS.TEASPOON,
    [
      "c a c",
      "c ac",
      "cac",
      "cc",
      "c a cafe",
      "cuillere a cafe",
      "cuilleres a cafe",
      "cuillere a the",
      "cuilleres a the",
      "tsp",
      "cuil a cafe",
      "cuil a c",
    ],
  ],
  [CANONICAL_UNITS.PINCH, ["pincee", "pincees"]],
  [CANONICAL_UNITS.CLOVE, ["gousse", "gousses"]],
  [CANONICAL_UNITS.SLICE, ["tranche", "tranches"]],
  [CANONICAL_UNITS.SACHET, ["sachet", "sachets"]],
  [CANONICAL_UNITS.TIN, ["boite", "boites", "conserve", "conserves"]],
  [CANONICAL_UNITS.JAR, ["pot", "pots"]],
  [CANONICAL_UNITS.BUNCH, ["botte", "bottes"]],
  [CANONICAL_UNITS.SPRIG, ["brin", "brins", "branche", "branches"]],
  [CANONICAL_UNITS.LEAF, ["feuille", "feuilles"]],
  [CANONICAL_UNITS.CUP, ["tasse", "tasses", "cup", "cups"]],
  [CANONICAL_UNITS.GLASS, ["verre", "verres"]],
  [CANONICAL_UNITS.HANDFUL, ["poignee", "poignees"]],
  [CANONICAL_UNITS.PIECE, ["morceau", "morceaux"]],
];

/** Longest alias first, so "c a soupe" wins over "c". */
const UNIT_LOOKUP: ReadonlyMap<string, string> = new Map(
  UNIT_ALIASES.flatMap(([canonical, aliases]) =>
    aliases.map((alias) => [unitKey(alias), canonical] as const),
  ),
);

const MAX_UNIT_TOKENS = 4;

const UNICODE_FRACTIONS: Readonly<Record<string, number>> = {
  "½": 0.5,
  "⅓": 1 / 3,
  "⅔": 2 / 3,
  "¼": 0.25,
  "¾": 0.75,
  "⅕": 0.2,
  "⅖": 0.4,
  "⅗": 0.6,
  "⅘": 0.8,
  "⅙": 1 / 6,
  "⅚": 5 / 6,
  "⅛": 0.125,
  "⅜": 0.375,
  "⅝": 0.625,
  "⅞": 0.875,
};

const FRACTION_CHARS = Object.keys(UNICODE_FRACTIONS).join("");

const OPTIONAL_MARKERS = ["optionnel", "optionnelle", "facultatif", "facultative"];

/** Elision and articles that sit between a unit and the ingredient name. */
const CONNECTORS = ["de", "des", "du", "d", "a", "au", "aux", "la", "le", "les"];

function unitKey(value: string): string {
  return normalizeTerm(value).replace(/\./g, "").replace(/\s+/g, " ").trim();
}

/** Splits a pasted block. Empty lines and list bullets disappear. */
export function parseIngredientBlock(block: string): ParsedIngredientLine[] {
  return block
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map(parseIngredientLine);
}

export function parseIngredientLine(line: string): ParsedIngredientLine {
  const original = line;
  let rest = line.trim().replace(/^[-*•·–—]+\s*/, "");

  const { optional, text: withoutOptional } = extractOptional(rest);
  rest = withoutOptional;

  const { note, text: withoutNote } = extractNote(rest);
  rest = withoutNote;

  const quantityResult = extractQuantity(rest);
  rest = quantityResult.rest;

  const unitResult = quantityResult.quantity === null
    ? { unit: null, rest }
    : extractUnit(rest);
  rest = unitResult.rest;

  if (unitResult.unit !== null) {
    rest = stripConnectors(rest);
  }

  const rawName = rest.replace(/\s+/g, " ").trim();

  // A line that parsed away to nothing is a line we misread. Keeping the input
  // as the name is always better than saving an empty ingredient row.
  if (rawName.length === 0) {
    return {
      quantity: null,
      unit: null,
      rawName: original.trim(),
      note,
      optional,
      original,
    };
  }

  return {
    quantity: quantityResult.quantity,
    unit: unitResult.unit,
    rawName,
    note,
    optional,
    original,
  };
}

function extractOptional(text: string): { optional: boolean; text: string } {
  const trailing = /[\s(\[]*(optionnel|optionnelle|facultatif|facultative)[\s)\]]*$/i;
  const match = trailing.exec(normalizeTerm(text));
  if (!match) {
    const hasMarker = OPTIONAL_MARKERS.some((marker) =>
      normalizeTerm(text).includes(marker),
    );
    if (!hasMarker) return { optional: false, text };
  }
  // Remove every parenthesised or trailing marker, whatever its position.
  const cleaned = text
    .replace(
      /[(\[]?\s*(optionnel|optionnelle|facultatif|facultative)\s*[)\]]?/gi,
      "",
    )
    .replace(/\s{2,}/g, " ")
    .replace(/[\s,;]+$/, "")
    .trim();
  return { optional: true, text: cleaned };
}

/**
 * Everything after the first comma becomes a note. This is wrong for a pasted
 * "sel, poivre", and right for "3 gousses d'ail, écrasées". The form is
 * editable, so the cheap rule wins over a clever one.
 */
function extractNote(text: string): { note: string | null; text: string } {
  const index = text.indexOf(",");
  if (index === -1) return { note: null, text };
  const note = text.slice(index + 1).trim();
  return {
    note: note.length > 0 ? note : null,
    text: text.slice(0, index).trim(),
  };
}

interface QuantityResult {
  readonly quantity: number | null;
  readonly rest: string;
}

function extractQuantity(text: string): QuantityResult {
  const decimal = String.raw`\d+(?:[.,]\d+)?`;

  // A range takes its upper bound: buying too little is the failure that ends
  // a cooking session, buying too much is the one that ends a leftover.
  const range = new RegExp(
    `^(${decimal})\\s*(?:-|\\u2013|a|à)\\s*(${decimal})(?=\\s|$)`,
    "i",
  );
  const rangeMatch = range.exec(text);
  if (rangeMatch) {
    return {
      quantity: toNumber(rangeMatch[2]!),
      rest: text.slice(rangeMatch[0].length).trim(),
    };
  }

  const mixedFraction = new RegExp(`^(\\d+)\\s+(\\d+)\\s*/\\s*(\\d+)(?=\\s|$)`);
  const mixedMatch = mixedFraction.exec(text);
  if (mixedMatch) {
    return {
      quantity:
        Number(mixedMatch[1]) + Number(mixedMatch[2]) / Number(mixedMatch[3]),
      rest: text.slice(mixedMatch[0].length).trim(),
    };
  }

  const mixedUnicode = new RegExp(`^(\\d+)\\s*([${FRACTION_CHARS}])`);
  const mixedUnicodeMatch = mixedUnicode.exec(text);
  if (mixedUnicodeMatch) {
    return {
      quantity:
        Number(mixedUnicodeMatch[1]) +
        (UNICODE_FRACTIONS[mixedUnicodeMatch[2]!] ?? 0),
      rest: text.slice(mixedUnicodeMatch[0].length).trim(),
    };
  }

  const fraction = /^(\d+)\s*\/\s*(\d+)(?=\s|$)/.exec(text);
  if (fraction) {
    return {
      quantity: Number(fraction[1]) / Number(fraction[2]),
      rest: text.slice(fraction[0].length).trim(),
    };
  }

  const unicode = new RegExp(`^([${FRACTION_CHARS}])`).exec(text);
  if (unicode) {
    return {
      quantity: UNICODE_FRACTIONS[unicode[1]!] ?? null,
      rest: text.slice(unicode[0].length).trim(),
    };
  }

  const plain = new RegExp(`^(${decimal})(?=\\s|$|[a-zA-Zà-ÿ])`).exec(text);
  if (plain) {
    return {
      quantity: toNumber(plain[1]!),
      rest: text.slice(plain[0].length).trim(),
    };
  }

  return { quantity: null, rest: text };
}

function toNumber(value: string): number {
  return Number(value.replace(",", "."));
}

interface UnitResult {
  readonly unit: string | null;
  readonly rest: string;
}

/**
 * Matches on whole tokens rather than on a prefix of the string, so the name
 * keeps its original accents and casing, and so "l'ail" is never read as a
 * litre of "ail".
 */
function extractUnit(text: string): UnitResult {
  const tokens = text.split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0) return { unit: null, rest: text };

  for (let take = Math.min(MAX_UNIT_TOKENS, tokens.length); take >= 1; take--) {
    const candidate = tokens.slice(0, take).join(" ");
    const unit = UNIT_LOOKUP.get(unitKey(candidate));
    if (unit) {
      return { unit, rest: tokens.slice(take).join(" ") };
    }
  }

  return { unit: null, rest: text };
}

function stripConnectors(text: string): string {
  let rest = text.trim();

  // Elision binds to the next word: "d'huile" is one token but two words.
  const elision = /^([dl])['’]\s*/i.exec(rest);
  if (elision) return rest.slice(elision[0].length).trim();

  const tokens = rest.split(/\s+/).filter((token) => token.length > 0);
  while (tokens.length > 1 && CONNECTORS.includes(unitKey(tokens[0]!))) {
    tokens.shift();
    const nextElision = /^([dl])['’]\s*/i.exec(tokens[0] ?? "");
    if (nextElision) {
      tokens[0] = tokens[0]!.slice(nextElision[0].length);
      break;
    }
  }

  rest = tokens.join(" ").trim();
  return rest;
}
