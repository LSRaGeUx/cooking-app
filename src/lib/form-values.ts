import { pluralizeUnit } from "@/domain/units";

/**
 * The three form and display helpers that were copied into five components.
 *
 * `optionalNumber` and `emptyToNull` were each defined three times, with the
 * same body and three different parameter types, and `formatQuantity` twice.
 * A quantity that reads as `3.000` on one screen and `3` on another is the kind
 * of drift a duplicated formatter produces, so there is now one of each.
 *
 * They take `FormDataEntryValue | null` rather than `string`, because a
 * `FormData` read returns `string | File | null` and every call site was
 * wrapping that in `String(...)`, which turns a missing field into the literal
 * `"null"` and a file into `"[object File]"`. Anything that is not a string is
 * treated as absent here instead.
 */

export function optionalNumber(
  value: FormDataEntryValue | null,
): number | null {
  const trimmed = asText(value);
  if (trimmed === null) return null;
  // A comma is what a French keyboard produces for a decimal separator, so it
  // is accepted rather than parsed as NaN.
  const parsed = Number(trimmed.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

export function emptyToNull(value: FormDataEntryValue | null): string | null {
  return asText(value);
}

/**
 * A quantity and its unit, as one string. Drops the trailing zeros a numeric
 * column brings back, so 3.000 reads as 3, and pluralizes the unit the way the
 * domain does, so 2 gousses is not 2 gousse.
 *
 * Returns the empty string when there is neither a quantity nor a unit, which
 * is the common case for "sel, poivre".
 */
export function formatQuantity(
  quantity: number | null,
  unit: string | null,
): string {
  const amount =
    quantity === null
      ? null
      : Number.isInteger(quantity)
        ? String(quantity)
        : String(Number(quantity.toFixed(2)));

  return [amount, pluralizeUnit(unit, quantity)]
    .filter((part): part is string => part !== null && part !== "")
    .join(" ");
}

function asText(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
