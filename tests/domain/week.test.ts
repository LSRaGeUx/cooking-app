import { describe, expect, it } from "vitest";
import {
  formatIsoWeek,
  isoWeekDates,
  isoWeekOf,
  isoWeekStart,
  isoWeeksInYear,
  parseIsoWeek,
  shiftIsoWeek,
} from "@/domain/week";

describe("ISO week arithmetic", () => {
  it("numbers a week by the year its Thursday falls in", () => {
    // 1 January 2027 is a Friday, so it belongs to the last week of 2026.
    expect(isoWeekOf(new Date(2027, 0, 1))).toEqual({ year: 2026, week: 53 });
    // 31 December 2024 is a Tuesday, so it belongs to the first week of 2025.
    expect(isoWeekOf(new Date(2024, 11, 31))).toEqual({ year: 2025, week: 1 });
  });

  it("starts every week on Monday", () => {
    const monday = isoWeekStart({ year: 2026, week: 36 });
    expect(monday.getUTCDay()).toBe(1);
    expect(monday.toISOString().slice(0, 10)).toBe("2026-08-31");
  });

  it("round-trips a date through its week", () => {
    const date = new Date(2026, 7, 31);
    const week = isoWeekOf(date);
    expect(isoWeekStart(week).toISOString().slice(0, 10)).toBe("2026-08-31");
  });

  it("gives seven consecutive dates", () => {
    const dates = isoWeekDates({ year: 2026, week: 1 });
    expect(dates).toHaveLength(7);
    expect(dates[0]!.toISOString().slice(0, 10)).toBe("2025-12-29");
    expect(dates[6]!.toISOString().slice(0, 10)).toBe("2026-01-04");
  });

  it("knows which years have 53 weeks", () => {
    expect(isoWeeksInYear(2026)).toBe(53);
    expect(isoWeeksInYear(2025)).toBe(52);
  });

  it("rolls over the year boundary when shifting", () => {
    expect(shiftIsoWeek({ year: 2026, week: 53 }, 1)).toEqual({
      year: 2027,
      week: 1,
    });
    expect(shiftIsoWeek({ year: 2027, week: 1 }, -1)).toEqual({
      year: 2026,
      week: 53,
    });
  });

  it("formats and parses the deep-link form", () => {
    expect(formatIsoWeek({ year: 2026, week: 7 })).toBe("2026-W07");
    expect(parseIsoWeek("2026-W07")).toEqual({ year: 2026, week: 7 });
  });

  it("rejects a week number the year does not have", () => {
    expect(parseIsoWeek("2025-W53")).toBeNull();
    expect(parseIsoWeek("2026-W53")).toEqual({ year: 2026, week: 53 });
    expect(parseIsoWeek("nonsense")).toBeNull();
  });
});
