/**
 * Every recipe carries a colour, and it is the same colour everywhere.
 *
 * A library of twenty dishes is a wall of identical rectangles, and the week
 * grid is worse: seven cards that differ only by a line of text. Giving each
 * recipe a stable hue turns both into something you read by shape and colour
 * before you read by word, which is how people actually recognise a dish they
 * have cooked before.
 *
 * The colour is derived, never stored: it costs no column, no migration and no
 * decision from the user, and it cannot drift out of sync with the recipe. The
 * hues are a culinary set on purpose, paprika through woad, so a screen full of
 * them still looks like food rather than like a chart.
 */

/** How many seals exist. The CSS defines one hue per index. */
export const SEAL_COUNT = 10;

/**
 * FNV-1a, because it is four lines, has no dependencies and spreads short ids
 * evenly. Cryptographic strength is irrelevant here: the worst outcome of a
 * collision is two recipes sharing a colour.
 */
export function recipeSeal(id: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % SEAL_COUNT;
}

/** The class that carries the seal variables. */
export function sealClass(id: string): string {
  return `seal-${recipeSeal(id)}`;
}
