import { describe, expect, it } from "vitest";
import { monthRange, monthsBetween, prevPeriod } from "../../src/lib/dates.js";

/**
 * Task 12, Step 1 — the date arithmetic the report routes lean on.
 *
 * All three functions take and return `YYYY-MM-DD` / `YYYY-MM` strings and do
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
