/**
 * Shopping cycles.
 *
 * A grocery list covers the days between two shops, not an ISO week. The cycle
 * is derived from one profile field, the shopping day, and runs seven days
 * starting on it: a cook who shops on Saturday gets Saturday to Friday, which
 * crosses the week boundary without anyone being asked about it. See
 * docs/01-functional-spec.md section 8.1.
 *
 * The shopping day itself is inside its cycle, so on the day you shop the list
 * has already switched to the week that starts now. That is the whole point of
 * deriving it rather than picking a range every trip.
 *
 * Everything here works in UTC midnights, like src/domain/week.ts, so a
 * timezone offset can never shift a date across a cycle boundary. The calendar
 * day used as input is the local one, because "today" for a cook is local.
 */

import {
  isIsoDay,
  isoWeekOf,
  isoWeekStart,
  type IsoDay,
  type IsoWeek,
} from "./week";

const DAY_MS = 86_400_000;

/** Seven days, one shop a week. A second weekly shop is not in v1. */
export const CYCLE_LENGTH_DAYS = 7;

export interface ShoppingCycle {
  /** UTC midnight of the first day covered, which is the shopping day. */
  readonly startsOn: Date;
  /** UTC midnight of the last day covered. */
  readonly endsOn: Date;
}

function utcFromLocalDate(date: Date): Date {
  return new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
  );
}

function isoDayOfUtc(date: Date): IsoDay {
  const day = date.getUTCDay();
  return (day === 0 ? 7 : day) as IsoDay;
}

/** The cycle that starts on `startsOn`, whatever weekday that is. */
export function cycleFromStart(startsOn: Date): ShoppingCycle {
  const start = new Date(
    Date.UTC(
      startsOn.getUTCFullYear(),
      startsOn.getUTCMonth(),
      startsOn.getUTCDate(),
    ),
  );
  return {
    startsOn: start,
    endsOn: new Date(start.getTime() + (CYCLE_LENGTH_DAYS - 1) * DAY_MS),
  };
}

/**
 * The cycle containing `date` for a cook who shops on `shoppingDay`.
 *
 * With no shopping day, the cycle is the ISO week containing the date, Monday
 * to Sunday, which is what the application did before shopping days existed.
 */
export function cycleContaining(
  date: Date,
  shoppingDay: number | null,
): ShoppingCycle {
  const today = utcFromLocalDate(date);

  // Takes a plain number rather than a narrowed IsoDay so every caller can hand
  // over the column as it comes back. A value outside 1 to 7 cannot reach the
  // database, and if one ever did it falls back to weeks instead of computing a
  // cycle nobody asked for.
  if (shoppingDay === null || !isIsoDay(shoppingDay)) {
    return cycleFromStart(isoWeekStart(isoWeekOf(date)));
  }

  // Days since the most recent shopping day, that day counting as zero.
  const elapsed = (isoDayOfUtc(today) - shoppingDay + 7) % 7;
  return cycleFromStart(new Date(today.getTime() - elapsed * DAY_MS));
}

/** Moves whole cycles, so the previous and next shop are one call away. */
export function shiftCycle(
  cycle: ShoppingCycle,
  delta: number,
): ShoppingCycle {
  return cycleFromStart(
    new Date(cycle.startsOn.getTime() + delta * CYCLE_LENGTH_DAYS * DAY_MS),
  );
}

export function isWithinCycle(cycle: ShoppingCycle, date: Date): boolean {
  const time = date.getTime();
  return time >= cycle.startsOn.getTime() && time <= cycle.endsOn.getTime();
}

/**
 * The ISO weeks a cycle touches, in order. Seven days starting on any weekday
 * touch one week or two, never three, but this derives them rather than
 * assuming it.
 */
export function isoWeeksInCycle(cycle: ShoppingCycle): IsoWeek[] {
  const weeks: IsoWeek[] = [];
  for (let offset = 0; offset < CYCLE_LENGTH_DAYS; offset += 1) {
    const day = new Date(cycle.startsOn.getTime() + offset * DAY_MS);
    // isoWeekOf reads local calendar fields, so a UTC midnight has to be handed
    // over as the same calendar day rather than as an instant.
    const week = isoWeekOf(
      new Date(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()),
    );
    if (weeks.some((known) => known.year === week.year && known.week === week.week)) {
      continue;
    }
    weeks.push(week);
  }
  return weeks;
}

/** The date a plan entry falls on. */
export function dateOfEntry(week: IsoWeek, dayOfWeek: number): Date {
  return new Date(isoWeekStart(week).getTime() + (dayOfWeek - 1) * DAY_MS);
}

/** `2026-09-05`, used in URLs so a cycle is deep-linkable. */
export function formatCycleStart(date: Date): string {
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function parseCycleStart(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  // Rejects 2026-02-30, which Date would roll over into March.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

export function isShoppingDay(value: unknown): value is IsoDay {
  return typeof value === "number" && isIsoDay(value);
}
