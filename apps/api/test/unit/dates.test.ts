import { describe, expect, it } from "vitest";
import {
  addDays,
  addMonths,
  daysBetween,
  daysInMonth,
  monthRange,
  monthsBetween,
  prevPeriod,
  todayUtc,
} from "../../src/lib/dates.js";

/**
 * Task 12, Step 1 — the date arithmetic the report routes lean on — extended
 * in Task 13 with the primitives the recurring-occurrence math builds on.
 *
 * All functions take and return `YYYY-MM-DD` / `YYYY-MM` strings and do
 * their arithmetic in UTC. There is no `Date` in any signature: a `Date` has a
 * time and a timezone, and a report that buckets by calendar month must not
 * have either — the month boundary is the one place a timezone would move a
 * row from the 31st into the 1st.
 */

describe("monthRange", () => {
  it("spans the first to the last day of the month", () => {
    expect(monthRange("2026-01")).toEqual({
      from: "2026-01-01",
      to: "2026-01-31",
    });
    expect(monthRange("2026-04")).toEqual({
      from: "2026-04-01",
      to: "2026-04-30",
    });
  });

  it("knows February in leap and non-leap years", () => {
    expect(monthRange("2026-02").to).toBe("2026-02-28");
    expect(monthRange("2028-02").to).toBe("2028-02-29");
    // 2100 is divisible by 100 but not 400: not a leap year.
    expect(monthRange("2100-02").to).toBe("2100-02-28");
  });

  it("handles December without rolling the year", () => {
    expect(monthRange("2025-12")).toEqual({
      from: "2025-12-01",
      to: "2025-12-31",
    });
  });
});

describe("prevPeriod", () => {
  it("is the immediately preceding period of equal length", () => {
    // A 7-day window ending the day before `from`.
    expect(prevPeriod("2026-03-08", "2026-03-14")).toEqual({
      from: "2026-03-01",
      to: "2026-03-07",
    });
  });

  it("ends the day before `from` even across a month boundary", () => {
    expect(prevPeriod("2026-03-01", "2026-03-31")).toEqual({
      // 31 days ending Feb 28: Jan 29 .. Feb 28.
      from: "2026-01-29",
      to: "2026-02-28",
    });
  });

  it("handles a single-day range", () => {
    expect(prevPeriod("2026-01-01", "2026-01-01")).toEqual({
      from: "2025-12-31",
      to: "2025-12-31",
    });
  });

  it("counts days, not months — equal length is a day count", () => {
    // 28-day February -> the 28 days before it, not "January".
    expect(prevPeriod("2026-02-01", "2026-02-28")).toEqual({
      from: "2026-01-04",
      to: "2026-01-31",
    });
  });
});

describe("addDays", () => {
  it("steps across month and year boundaries", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-12-24", 7)).toBe("2026-12-31");
  });

  it("accepts negative day counts", () => {
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
  });

  it("zero is identity", () => {
    expect(addDays("2026-06-15", 0)).toBe("2026-06-15");
  });
});

describe("daysBetween", () => {
  it("counts whole days from `from` to `to`", () => {
    expect(daysBetween("2026-01-01", "2026-01-31")).toBe(30);
    expect(daysBetween("2025-12-31", "2026-01-01")).toBe(1);
  });

  it("is zero for the same date and negative when `to` precedes `from`", () => {
    expect(daysBetween("2026-05-05", "2026-05-05")).toBe(0);
    expect(daysBetween("2026-01-31", "2026-01-01")).toBe(-30);
  });

  it("crosses a leap February without losing a day", () => {
    expect(daysBetween("2028-02-01", "2028-03-01")).toBe(29);
    expect(daysBetween("2026-02-01", "2026-03-01")).toBe(28);
  });
});

describe("daysInMonth", () => {
  it("knows February across the leap cycle", () => {
    expect(daysInMonth("2024-02")).toBe(29);
    expect(daysInMonth("2026-02")).toBe(28);
    expect(daysInMonth("2028-02")).toBe(29);
    // 2100 is divisible by 100 but not 400: not a leap year.
    expect(daysInMonth("2100-02")).toBe(28);
  });

  it("knows 30- and 31-day months", () => {
    expect(daysInMonth("2026-01")).toBe(31);
    expect(daysInMonth("2026-04")).toBe(30);
    expect(daysInMonth("2026-12")).toBe(31);
  });

  it("accepts a full `YYYY-MM-DD`, ignoring the day", () => {
    expect(daysInMonth("2026-02-15")).toBe(28);
  });
});

describe("addMonths", () => {
  it("steps within and across a year", () => {
    expect(addMonths("2026-01", 1)).toBe("2026-02");
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2026-11", 14)).toBe("2028-01");
  });

  it("accepts negative and zero counts", () => {
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(addMonths("2026-06", 0)).toBe("2026-06");
  });
});

describe("todayUtc", () => {
  it("is today's UTC date as YYYY-MM-DD", () => {
    // Sample the clock on both sides so the assertion cannot flake if the
    // test straddles UTC midnight.
    const before = new Date().toISOString().slice(0, 10);
    const today = todayUtc();
    const after = new Date().toISOString().slice(0, 10);
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect([before, after]).toContain(today);
  });
});

describe("monthsBetween", () => {
  it("lists every month the range touches, inclusive of both ends", () => {
    expect(monthsBetween("2025-11-15", "2026-02-03")).toEqual([
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
    ]);
  });

  it("is a single month when both dates fall in it", () => {
    expect(monthsBetween("2026-05-02", "2026-05-30")).toEqual(["2026-05"]);
  });

  it("is empty when from is after to", () => {
    expect(monthsBetween("2026-06-01", "2026-05-31")).toEqual([]);
  });
});
