/**
 * One string that names a (day, meal type) pair, and one function that reads it
 * back.
 *
 * Three components encoded this by hand and two of them parsed it by hand, each
 * slightly differently: the week grid rejected a key whose day was not an
 * integer, the slot editor did not, and the entry panel used `split(":")` and
 * so lost anything after a second colon. They are the ids of drag-and-drop
 * droppables and the values of `<option>` elements, so an encoder and a parser
 * that disagree are a drop that silently lands nowhere.
 *
 * `mealTypeId` is a UUID and contains no colon, so the first colon is always
 * the separator. Splitting there rather than on every colon is what makes the
 * parse total.
 *
 * This belongs in `src/domain/slots.ts` beside `SlotRef`, which is what it
 * builds: `src/services/plan-service.ts` keeps a private copy of the same
 * encoder for exactly the same purpose. It is here because the domain does not
 * export one yet. See the report accompanying this change.
 */
export function slotKey(dayOfWeek: number, mealTypeId: string): string {
  return `${dayOfWeek}:${mealTypeId}`;
}

export function parseSlotKey(
  key: string,
): { dayOfWeek: number; mealTypeId: string } | null {
  const separator = key.indexOf(":");
  if (separator === -1) return null;

  const dayOfWeek = Number(key.slice(0, separator));
  const mealTypeId = key.slice(separator + 1);
  if (!Number.isInteger(dayOfWeek) || dayOfWeek < 1 || dayOfWeek > 7) {
    return null;
  }
  if (mealTypeId.length === 0) return null;

  return { dayOfWeek, mealTypeId };
}
