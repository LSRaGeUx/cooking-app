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
 * Three rules decide the output:
 *
 * 1. **Only linked ingredients merge.** An unlinked line is a name someone
 *    typed, and two spellings that look alike are not evidence that they are
 *    the same thing. It still shops fine, it just gets its own line.
 * 2. **Unconvertible units never fake a sum.** "2 oignons" plus "300 g
 *    d'oignons" stays two lines under one heading, which is what
 *    `unmergeableGroup` carries.
 * 3. **Quantities scale by servings**, because a recipe's quantities are
 *    written for its own serving count and the plan entry may want another.
 */

export interface GrocerySourceLine {
  readonly entryId: string;
  readonly ingredientId: string | null;
  /** The canonical name when linked, otherwise the name as written. */
  readonly displayName: string;
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
}

export interface AggregateOptions {
  /**
   * Optional ingredients are left out by default: a shopping list that lists
   * everything anyone might add is a list nobody trusts.
   */
  readonly includeOptional?: boolean;
}

interface Bucket {
  ingredientId: string | null;
  displayName: string;
  aisle: string | null;
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

export function aggregateGroceryLines(
  lines: readonly GrocerySourceLine[],
  options: AggregateOptions = {},
): AggregatedGroceryLine[] {
  const buckets = new Map<string, Bucket>();
  let unlinkedCounter = 0;

  for (const line of lines) {
    if (line.optional && options.includeOptional !== true) continue;

    // An unlinked line gets a key nothing else can collide with, which is how
    // "does not merge" is expressed rather than special-cased later.
    const mergeKey =
      line.ingredientId ?? `unlinked:${unlinkedCounter++}:${line.displayName}`;
    const dimension = unitDimension(line.unit);
    const countUnit = dimension === "count" ? (line.unit ?? UNITLESS) : null;
    const bucketKey = `${mergeKey}|${dimension}|${countUnit ?? ""}`;

    const existing = buckets.get(bucketKey);
    const bucket: Bucket = existing ?? {
      ingredientId: line.ingredientId,
      displayName: line.displayName,
      aisle: line.aisle,
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
 * When one ingredient came in both as a volume and as a mass, and the user's
 * ingredient record says how heavy a millilitre of it is, the two become one
 * line. Without a density they stay apart, which is the honest outcome.
 */
function mergeVolumeIntoMass(buckets: Bucket[]): Bucket[] {
  const byIngredient = new Map<string, Bucket[]>();
  for (const bucket of buckets) {
    if (bucket.ingredientId === null) continue;
    const group = byIngredient.get(bucket.ingredientId) ?? [];
    group.push(bucket);
    byIngredient.set(bucket.ingredientId, group);
  }

  const absorbed = new Set<Bucket>();

  for (const group of byIngredient.values()) {
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
  // An ingredient left with several buckets could not be summed, so its lines
  // are tied together for display instead of being silently scattered.
  const bucketsPerIngredient = new Map<string, number>();
  for (const bucket of buckets) {
    if (bucket.ingredientId === null) continue;
    bucketsPerIngredient.set(
      bucket.ingredientId,
      (bucketsPerIngredient.get(bucket.ingredientId) ?? 0) + 1,
    );
  }

  const lines = buckets.map((bucket) => {
    const unmergeableGroup =
      bucket.ingredientId !== null &&
      (bucketsPerIngredient.get(bucket.ingredientId) ?? 0) > 1
        ? bucket.ingredientId
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
    };
  });

  return lines.sort(compareLines);
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
