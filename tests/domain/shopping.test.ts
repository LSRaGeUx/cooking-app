import { describe, expect, it } from "vitest";
import {
  cycleContaining,
  cycleFromStart,
  dateOfEntry,
  formatCycleStart,
  isoWeeksInCycle,
  isWithinCycle,
  parseCycleStart,
  shiftCycle,
} from "@/domain/shopping";

/** 2026-09-05 is a Saturday, so it is the natural example throughout. */
const saturday = 6;

describe("cycleContaining", () => {
  it("starts on the shopping day itself", () => {
    // Shopping on Saturday, asked on that Saturday: the cycle that starts now.
    const cycle = cycleContaining(new Date(2026, 8, 5), saturday);
    expect(formatCycleStart(cycle.startsOn)).toBe("2026-09-05");
    expect(formatCycleStart(cycle.endsOn)).toBe("2026-09-11");
  });

  it("looks back to the last shop on any other day", () => {
    const cycle = cycleContaining(new Date(2026, 8, 9), saturday);
    expect(formatCycleStart(cycle.startsOn)).toBe("2026-09-05");
  });

  it("switches on the next shopping day", () => {
    const before = cycleContaining(new Date(2026, 8, 11), saturday);
    const after = cycleContaining(new Date(2026, 8, 12), saturday);
    expect(formatCycleStart(before.startsOn)).toBe("2026-09-05");
    expect(formatCycleStart(after.startsOn)).toBe("2026-09-12");
  });

  it("falls back to the ISO week when no shopping day is set", () => {
    // Wednesday 9 September 2026 sits in the week starting Monday the 7th.
    const cycle = cycleContaining(new Date(2026, 8, 9), null);
    expect(formatCycleStart(cycle.startsOn)).toBe("2026-09-07");
    expect(formatCycleStart(cycle.endsOn)).toBe("2026-09-13");
  });

  it("handles a cycle that crosses the new year", () => {
    const cycle = cycleContaining(new Date(2026, 11, 31), saturday);
    expect(formatCycleStart(cycle.startsOn)).toBe("2026-12-26");
    expect(formatCycleStart(cycle.endsOn)).toBe("2027-01-01");
  });
});

describe("isoWeeksInCycle", () => {
  it("spans two weeks when the shopping day is not a Monday", () => {
    const cycle = cycleFromStart(new Date(Date.UTC(2026, 8, 5)));
    expect(isoWeeksInCycle(cycle)).toEqual([
      { year: 2026, week: 36 },
      { year: 2026, week: 37 },
    ]);
  });

  it("spans one week when it starts on a Monday", () => {
    const cycle = cycleFromStart(new Date(Date.UTC(2026, 8, 7)));
    expect(isoWeeksInCycle(cycle)).toEqual([{ year: 2026, week: 37 }]);
  });

  it("never spans more than two weeks", () => {
    for (let offset = 0; offset < 400; offset += 1) {
      const start = new Date(Date.UTC(2026, 0, 1) + offset * 86_400_000);
      expect(isoWeeksInCycle(cycleFromStart(start)).length).toBeLessThanOrEqual(2);
    }
  });
});

describe("shiftCycle", () => {
  it("moves a whole cycle at a time", () => {
    const cycle = cycleFromStart(new Date(Date.UTC(2026, 8, 5)));
    expect(formatCycleStart(shiftCycle(cycle, 1).startsOn)).toBe("2026-09-12");
    expect(formatCycleStart(shiftCycle(cycle, -1).startsOn)).toBe("2026-08-29");
  });
});

describe("isWithinCycle", () => {
  const cycle = cycleFromStart(new Date(Date.UTC(2026, 8, 5)));

  it("includes both ends", () => {
    expect(isWithinCycle(cycle, new Date(Date.UTC(2026, 8, 5)))).toBe(true);
    expect(isWithinCycle(cycle, new Date(Date.UTC(2026, 8, 11)))).toBe(true);
  });

  it("excludes the day before and the day after", () => {
    expect(isWithinCycle(cycle, new Date(Date.UTC(2026, 8, 4)))).toBe(false);
    expect(isWithinCycle(cycle, new Date(Date.UTC(2026, 8, 12)))).toBe(false);
  });
});

describe("dateOfEntry", () => {
  it("maps a week and an ISO day to a date", () => {
    // Monday of 2026-W37 is 7 September, so Saturday is the 12th.
    expect(formatCycleStart(dateOfEntry({ year: 2026, week: 37 }, 1))).toBe(
      "2026-09-07",
    );
    expect(formatCycleStart(dateOfEntry({ year: 2026, week: 37 }, 6))).toBe(
      "2026-09-12",
    );
  });
});

describe("parseCycleStart", () => {
  it("accepts an ISO date", () => {
    expect(formatCycleStart(parseCycleStart("2026-09-05")!)).toBe("2026-09-05");
  });

  it("rejects anything else", () => {
    // A rolled-over date would silently shop for the wrong week.
    expect(parseCycleStart("2026-02-30")).toBeNull();
    expect(parseCycleStart("2026-W36")).toBeNull();
    expect(parseCycleStart("")).toBeNull();
  });
});
