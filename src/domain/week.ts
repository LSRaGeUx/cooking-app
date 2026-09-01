/**
 * ISO-8601 week arithmetic, always with an explicit year. A bare week number is
 * ambiguous across a year boundary, which is exactly the case that breaks in
 * production in early January. See docs/01-functional-spec.md section 13.
 *
 * Everything here works in UTC internally so a timezone offset can never shift
 * a date across a week boundary. The calendar day used as input is the local
 * one, because "today" for a cook is a local notion.
 */

export interface IsoWeek {
  readonly year: number;
  readonly week: number;
}

const DAY_MS = 86_400_000;

/** ISO weekdays, 1 = Monday through 7 = Sunday. */
export const ISO_DAYS = [1, 2, 3, 4, 5, 6, 7] as const;
export type IsoDay = (typeof ISO_DAYS)[number];

export function isIsoDay(value: number): value is IsoDay {
  return Number.isInteger(value) && value >= 1 && value <= 7;
}

function utcFromLocalDate(date: Date): Date {
  return new Date(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()),
  );
}

/**
 * The ISO week containing `date`. The year returned is the ISO week-numbering
 * year, which is not always the calendar year: 2027-01-01 falls in 2026-W53.
 */
export function isoWeekOf(date: Date): IsoWeek {
  const d = utcFromLocalDate(date);
  // Shift to the Thursday of this week: the ISO year is whichever year that
  // Thursday falls in, which is the whole trick of ISO week numbering.
  const isoDay = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + 4 - isoDay);
  const year = d.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const week = Math.ceil(((d.getTime() - jan1) / DAY_MS + 1) / 7);
  return { year, week };
}

export function currentIsoWeek(now: Date = new Date()): IsoWeek {
  return isoWeekOf(now);
}

/** The Monday of the given ISO week, at UTC midnight. */
export function isoWeekStart({ year, week }: IsoWeek): Date {
  // 4 January is by definition always in week 1.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const isoDay = jan4.getUTCDay() === 0 ? 7 : jan4.getUTCDay();
  const week1Monday = jan4.getTime() - (isoDay - 1) * DAY_MS;
  return new Date(week1Monday + (week - 1) * 7 * DAY_MS);
}

/** The seven dates of the week, Monday first. */
export function isoWeekDates(week: IsoWeek): Date[] {
  const monday = isoWeekStart(week).getTime();
  return ISO_DAYS.map((day) => new Date(monday + (day - 1) * DAY_MS));
}

export function isoWeekDate(week: IsoWeek, day: IsoDay): Date {
  return new Date(isoWeekStart(week).getTime() + (day - 1) * DAY_MS);
}

/** 52 or 53, depending on the year. 28 December is always in the last week. */
export function isoWeeksInYear(year: number): number {
  return isoWeekOf(new Date(year, 11, 28)).week;
}

/** Moves `delta` weeks, rolling over the year boundary correctly. */
export function shiftIsoWeek(week: IsoWeek, delta: number): IsoWeek {
  const shifted = new Date(isoWeekStart(week).getTime() + delta * 7 * DAY_MS);
  return isoWeekOf(
    new Date(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth(),
      shifted.getUTCDate(),
    ),
  );
}

export function isValidIsoWeek({ year, week }: IsoWeek): boolean {
  if (!Number.isInteger(year) || year < 1970 || year > 9999) return false;
  if (!Number.isInteger(week) || week < 1) return false;
  return week <= isoWeeksInYear(year);
}

export function isSameIsoWeek(a: IsoWeek, b: IsoWeek): boolean {
  return a.year === b.year && a.week === b.week;
}

/**
 * Whole weeks from `from` to `to`, negative when `to` is earlier. Computed from
 * the Monday of each week rather than by subtracting week numbers, which would
 * be wrong across a year boundary and across a 53-week year.
 */
export function weeksBetween(from: IsoWeek, to: IsoWeek): number {
  const delta = isoWeekStart(to).getTime() - isoWeekStart(from).getTime();
  return Math.round(delta / (7 * DAY_MS));
}

/** `2026-W36`, the ISO-8601 form, used in URLs so a week is deep-linkable. */
export function formatIsoWeek({ year, week }: IsoWeek): string {
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export function parseIsoWeek(value: string): IsoWeek | null {
  const match = /^(\d{4})-W(\d{1,2})$/.exec(value.trim());
  if (!match) return null;
  const candidate = { year: Number(match[1]), week: Number(match[2]) };
  return isValidIsoWeek(candidate) ? candidate : null;
}
