import { normalizeTerm } from "./allergens";
import {
  fromBaseQuantity,
  normalizeBaseQuantity,
  prefersSourceUnit,
  round,
  roundCountable,
  toBaseQuantity,
  unitDimension,
  volumeToMass,
  UNITLESS,
} from "./units";

/**
 * Turning a week of plan entries into a shopping list.
 *
 * Pure and I/O-free: reading the plan and writing the list is the service's
 * job, and everything worth arguing about is here where it can be tested.
 *
 * The rules that decide the output:
 *
 * 1. **A line names the product to buy.** The linked ingredient is a
 *    vocabulary entry, not a shelf: "coulis de tomate" links to `Tomate` for
 *    its aisle and its allergens, and buying a tomato instead is not the same
 *    trip. So only the ingredient's own name is read back; every other written
 *    name is kept as written and merges only with itself. See `productOf`.
 * 2. **Only linked ingredients merge.** An unlinked line is a name someone
 *    typed, and two spellings that look alike are not evidence that they are
 *    the same thing. It still shops fine, it just gets its own line.
 * 3. **Unconvertible units never fake a sum.** "2 oignons" plus "300 g
 *    d'oignons" stays two lines under one heading, which is what
 *    `unmergeableGroup` carries.
 * 4. **Quantities scale by servings**, because a recipe's quantities are
 *    written for its own serving count and the plan entry may want another.
 * 5. **Optional stays optional.** An optional ingredient gets its own bucket
 *    and carries the flag out, so the list can set it aside in a section of its
 *    own rather than hide it or pad a required quantity with it.
 */

export interface GrocerySourceLine {
  readonly entryId: string;
  readonly ingredientId: string | null;
  /** The name as written in the recipe. */
  readonly rawName: string;
  /** The linked ingredient's canonical name, when the line is linked. */
  readonly canonicalName: string | null;
  readonly aisle: string | null;
  readonly quantity: number | null;
  readonly unit: string | null;
  readonly optional: boolean;
  /** From the linked ingredient, when it has one. Enables volume to mass. */
  readonly densityGPerMl: number | null;
}

export interface AggregatedGroceryLine {
  readonly ingredientId: string | null;
  readonly displayName: string;
  readonly aisle: string | null;
  readonly quantity: number | null;
  readonly unit: string | null;
  readonly sourceEntryIds: string[];
  readonly unmergeableGroup: string | null;
  /** Every recipe that asked for this line called the ingredient optional. */
  readonly optional: boolean;
  /**
   * The written name is a narrower product than the ingredient it is linked to.
   * The link still gives an aisle and an allergen set, but nothing the cook
   * already has of the ingredient covers this line.
   */
  readonly productVariant: boolean;
}

interface Bucket {
  ingredientId: string | null;
  /** What "the same product" means for this bucket. See `productOf`. */
  productKey: string;
  productVariant: boolean;
  displayName: string;
  aisle: string | null;
  /** Never shared with a required bucket, so the two totals stay apart. */
  optional: boolean;
  dimension: "mass" | "volume" | "count";
  /** The literal unit for countables, which never convert. */
  countUnit: string | null;
  baseQuantity: number | null;
  countQuantity: number | null;
  /** Every unit that contributed, so a single-unit total can read as itself. */
  units: Set<string | null>;
  sourceEntryIds: Set<string>;
  densityGPerMl: number | null;
}

interface Product {
  /** Merge identity, or null for a line that merges with nothing. */
  readonly key: string | null;
  readonly displayName: string;
  readonly variant: boolean;
}

/**
 * Which product a source line is shopping for, and what to call it.
 *
 * Only the ingredient's own name counts as the ingredient. "Oignon" written as
 * "oignons" or "OIGNON" is the same word, so it reads back as `Oignon` and adds
 * up. Anything else keeps the name it was written with and merges only with the
 * same written name: two recipes asking for "coulis de tomate" make one line of
 * 500 ml, and "pain de mie" never joins "pain à burger".
 *
 * Aliases are deliberately not consulted here, though they are what linked the
 * line in the first place. An alias says "this text means that ingredient",
 * which is what the aisle, the merging and the allergen derivation need; it does
 * not say the two are the same thing to buy, and most of them are not:
 * "spaghetti" resolves to `Pâtes` and "thym" to `Herbes de Provence`. Reading an
 * alias back as its canonical name is what put the wrong word on the list, so
 * the alias earns the link and stops there.
 *
 * The cost, accepted: two written names that both differ from the canonical one
 * do not add up. "patate" and "pomme de terre" make two lines. Nobody buys the
 * wrong thing from that, and the alternative is a list naming something the
 * recipe never asked for.
 */
function productOf(line: GrocerySourceLine): Product {
  const written = line.rawName.trim();

  if (line.ingredientId === null || line.canonicalName === null) {
    return { key: null, displayName: written, variant: false };
  }

  if (productKey(written) === productKey(line.canonicalName)) {
    return {
      key: line.ingredientId,
      displayName: line.canonicalName,
      variant: false,
    };
  }

  return {
    key: `${line.ingredientId}#${productKey(written)}`,
    displayName: written,
    variant: true,
  };
}

/**
 * Two written names collapse onto one key when they differ only in case,
 * accents, punctuation or a French plural. That keeps "coulis de tomate" and
 * "coulis de tomates" on one line without asserting anything about two names
 * that actually differ. Short words are left alone, so "jus" and "os" survive.
 */
function productKey(value: string): string {
  return normalizeTerm(value)
    .split(" ")
    .map((word) => (word.length > 3 ? word.replace(/[sx]$/, "") : word))
    .join(" ");
}

export function aggregateGroceryLines(
  lines: readonly GrocerySourceLine[],
): AggregatedGroceryLine[] {
  const buckets = new Map<string, Bucket>();
  let unlinkedCounter = 0;

  for (const line of lines) {
    const product = productOf(line);
    // An unlinked line gets a key nothing else can collide with, which is how
    // "does not merge" is expressed rather than special-cased later.
    const mergeKey =
      product.key ?? `unlinked:${unlinkedCounter++}:${product.displayName}`;
    const dimension = unitDimension(line.unit);
    const countUnit = dimension === "count" ? (line.unit ?? UNITLESS) : null;
    const optionality = line.optional ? "optional" : "required";
    const bucketKey = `${mergeKey}|${dimension}|${countUnit ?? ""}|${optionality}`;

    const existing = buckets.get(bucketKey);
    const bucket: Bucket = existing ?? {
      ingredientId: line.ingredientId,
      productKey: mergeKey,
      productVariant: product.variant,
      displayName: product.displayName,
      aisle: line.aisle,
      optional: line.optional,
      dimension,
      countUnit,
      baseQuantity: null,
      countQuantity: null,
      units: new Set(),
      sourceEntryIds: new Set(),
      densityGPerMl: line.densityGPerMl,
    };

    bucket.units.add(line.unit);
    bucket.sourceEntryIds.add(line.entryId);
    bucket.densityGPerMl ??= line.densityGPerMl;

    if (line.quantity !== null) {
      if (dimension === "count") {
        bucket.countQuantity = (bucket.countQuantity ?? 0) + line.quantity;
      } else {
        const base = toBaseQuantity(line.quantity, line.unit);
        if (base !== null) bucket.baseQuantity = (bucket.baseQuantity ?? 0) + base;
      }
    }

    buckets.set(bucketKey, bucket);
  }

  const merged = mergeVolumeIntoMass([...buckets.values()]);
  return toLines(merged);
}

/**
 * When one product came in both as a volume and as a mass, and the user's
 * ingredient record says how heavy a millilitre of it is, the two become one
 * line. Without a density they stay apart, which is the honest outcome.
 */
function mergeVolumeIntoMass(buckets: Bucket[]): Bucket[] {
  const byProduct = new Map<string, Bucket[]>();
  for (const bucket of buckets) {
    const key = groupKey(bucket);
    if (key === null) continue;
    const group = byProduct.get(key) ?? [];
    group.push(bucket);
    byProduct.set(key, group);
  }

  const absorbed = new Set<Bucket>();

  for (const group of byProduct.values()) {
    const mass = group.find((bucket) => bucket.dimension === "mass");
    const volume = group.find((bucket) => bucket.dimension === "volume");
    if (!mass || !volume) continue;

    const density = mass.densityGPerMl ?? volume.densityGPerMl;
    const converted = volumeToMass(volume.baseQuantity ?? 0, density);
    if (converted === null) continue;

    mass.baseQuantity = (mass.baseQuantity ?? 0) + converted;
    for (const entryId of volume.sourceEntryIds) mass.sourceEntryIds.add(entryId);
    for (const unit of volume.units) mass.units.add(unit);
    absorbed.add(volume);
  }

  return buckets.filter((bucket) => !absorbed.has(bucket));
}

function toLines(buckets: readonly Bucket[]): AggregatedGroceryLine[] {
  // A product left with several buckets could not be summed, so its lines are
  // tied together for display instead of being silently scattered.
  const bucketsPerProduct = new Map<string, number>();
  for (const bucket of buckets) {
    const key = groupKey(bucket);
    if (key === null) continue;
    bucketsPerProduct.set(key, (bucketsPerProduct.get(key) ?? 0) + 1);
  }

  const lines = buckets.map((bucket) => {
    // The token is the product itself, not the counting key: the required
    // and the optional half of one product are never displayed together.
    const key = groupKey(bucket);
    const unmergeableGroup =
      key !== null && (bucketsPerProduct.get(key) ?? 0) > 1
        ? bucket.productKey
        : null;

    if (bucket.dimension === "count") {
      return {
        ingredientId: bucket.ingredientId,
        displayName: bucket.displayName,
        aisle: bucket.aisle,
        quantity:
          bucket.countQuantity === null
            ? null
            : roundCountable(bucket.countQuantity),
        unit: bucket.countUnit === UNITLESS ? null : bucket.countUnit,
        sourceEntryIds: [...bucket.sourceEntryIds],
        unmergeableGroup,
        optional: bucket.optional,
        productVariant: bucket.productVariant,
      };
    }

    if (bucket.baseQuantity === null) {
      return {
        ingredientId: bucket.ingredientId,
        displayName: bucket.displayName,
        aisle: bucket.aisle,
        quantity: null,
        unit: null,
        sourceEntryIds: [...bucket.sourceEntryIds],
        unmergeableGroup,
        optional: bucket.optional,
        productVariant: bucket.productVariant,
      };
    }

    const rendered = renderMeasured(bucket);
    return {
      ingredientId: bucket.ingredientId,
      displayName: bucket.displayName,
      aisle: bucket.aisle,
      quantity: rendered.quantity,
      unit: rendered.unit,
      sourceEntryIds: [...bucket.sourceEntryIds],
      unmergeableGroup,
      optional: bucket.optional,
      productVariant: bucket.productVariant,
    };
  });

  return lines.sort(compareLines);
}

/**
 * What counts as "the same shopping" when buckets are compared: the product and
 * its optionality together. Without the second half, an optional bucket would
 * be poured into the required one it can never be summed with. The product
 * rather than the ingredient, so a coulis is never grouped with a tomato.
 * Null for an unlinked line, which merges with nothing.
 */
function groupKey(bucket: Bucket): string | null {
  if (bucket.ingredientId === null) return null;
  return `${bucket.productKey}|${bucket.optional ? "optional" : "required"}`;
}

/**
 * A summed mass or volume, in the unit a person would write it in. When every
 * contribution used one spoon-like unit, the total reads in that unit; anything
 * else normalizes onto the metric scale.
 */
function renderMeasured(bucket: Bucket): {
  quantity: number;
  unit: string;
} {
  const baseQuantity = bucket.baseQuantity ?? 0;
  const dimension = bucket.dimension === "mass" ? "mass" : "volume";

  if (bucket.units.size === 1) {
    const [only] = [...bucket.units];
    if (prefersSourceUnit(only ?? null)) {
      const inSourceUnit = fromBaseQuantity(baseQuantity, only!);
      if (inSourceUnit !== null) {
        return { quantity: round(inSourceUnit), unit: only! };
      }
    }
  }

  return normalizeBaseQuantity(baseQuantity, dimension);
}

/** Aisle order, then name. An ingredient with no aisle sorts last. */
export function compareLines(
  a: Pick<AggregatedGroceryLine, "aisle" | "displayName">,
  b: Pick<AggregatedGroceryLine, "aisle" | "displayName">,
): number {
  if (a.aisle !== b.aisle) {
    if (a.aisle === null) return 1;
    if (b.aisle === null) return -1;
    return a.aisle.localeCompare(b.aisle, "fr");
  }
  return a.displayName.localeCompare(b.displayName, "fr");
}

/**
 * Scales one recipe quantity from the servings it was written for to the
 * servings the plan entry asks for. A recipe with no serving count is left
 * alone rather than divided by zero.
 */
export function scaleQuantity(
  quantity: number | null,
  recipeServings: number,
  entryServings: number,
): number | null {
  if (quantity === null) return null;
  if (recipeServings <= 0) return quantity;
  return round((quantity * entryServings) / recipeServings);
}
