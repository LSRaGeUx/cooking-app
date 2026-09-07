/**
 * Deriving a stable key from a label the user typed.
 *
 * A meal type and a piece of equipment are both identified by a key, and the
 * key is derived rather than asked for: nobody types `pressure_cooker` next to
 * "Cocotte-minute", and a key the user can edit is a key that gets edited into
 * a duplicate.
 *
 * It lives in the domain because the derivation is a rule, not a presentation
 * detail. It was copied into two components, `slot-editor.tsx` and
 * `constraint-lists.tsx`, which meant an MCP caller adding a meal type derived
 * its key one way and the screen derived it another, and two keys for one label
 * is two rows for one meal.
 *
 * The rules, unchanged from those two copies:
 *
 * 1. **Accents fold to their base letter.** `Dîner` and `Diner` are one key.
 *    NFD then dropping the combining marks, the same normalization
 *    src/domain/allergens.ts uses, so the two files agree about what a French
 *    letter is.
 * 2. **Anything that is not a lowercase letter or a digit becomes `_`,** and
 *    runs of them collapse. `Petit-déjeuner` is `petit_dejeuner`; so is
 *    `petit  déjeuner`.
 * 3. **No leading or trailing separator.**
 * 4. **Forty characters,** which is what `mealTypeInputSchema.key` and
 *    `equipmentInputSchema.key` allow.
 * 5. **A label that leaves nothing behind gets the caller's fallback,** because
 *    the empty string is not a key and the two call sites want different words
 *    for it. Both schemas require `^[a-z0-9_]+$`, so a label made entirely of
 *    punctuation cannot be allowed to produce an empty key.
 */
export function slugify(label: string, fallback = "cle"): string {
  const slug = label
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40)
    // The slice can leave a trailing separator that was in the middle before.
    .replace(/_+$/g, "");

  return slug.length > 0 ? slug : fallback;
}
