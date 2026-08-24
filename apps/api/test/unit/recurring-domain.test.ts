import { describe, expect, it } from "vitest";
import {
  firstOccurrenceOnOrAfter,
  nextOccurrence,
  occurrencesThrough,
} from "../../src/domain/recurring.js";

/**
 * Task 13, Step 1 — occurrence math, as pure functions.
 *
 * design/schema.md: a rule anchored on the 29th–31st fires on the last day of
 * shorter months and returns to its anchor day afterward. The next occurrence
 * is always computed from the anchor day-of-month in `start_date`, never by
 * incrementing the previously clamped date — incrementing the clamped date
 * drifts permanently (Jan 31 -> Feb 28 -> Mar 28 -> ...).
 *
 * Contracts pinned here beyond the clamp itself:
 * - `nextOccurrence` is an infinite stepper: it ignores `endDate` and always
 *   has a next date. Termination belongs to `occurrencesThrough` alone.
 * - `occurrencesThrough`'s `from` bound is INCLUSIVE. Task 14 passes
 *   `next_occurrence` as `from`, and `next_occurrence` is by definition a date
 *   that must be generated; an exclusive `from` silently skips the first
 *   occurrence of every catch-up.
 */

const monthly31 = { frequency: "monthly", startDate: "2026-01-31" } as const;

describe("nextOccurrence", () => {
  it("Jan 31 -> Feb 28 -> Mar 31 (anchor preserved, no drift)", () => {
    const feb = nextOccurrence(monthly31, "2026-01-31");
    expect(feb).toBe("2026-02-28");
    const mar = nextOccurrence(monthly31, feb);
    expect(mar).toBe("2026-03-31");
  });

  it("leap year: anchor 31 -> 2028-02-29", () => {
    const rule = { frequency: "monthly", startDate: "2028-01-31" } as const;
    expect(nextOccurrence(rule, "2028-01-31")).toBe("2028-02-29");
  });

  it("anchor 30 over February; anchor 29 in a non-leap February", () => {
    const anchor30 = { frequency: "monthly", startDate: "2026-01-30" } as const;
    expect(nextOccurrence(anchor30, "2026-01-30")).toBe("2026-02-28");
    expect(nextOccurrence(anchor30, "2026-02-28")).toBe("2026-03-30");

    const anchor29 = { frequency: "monthly", startDate: "2026-01-29" } as const;
    expect(nextOccurrence(anchor29, "2026-01-29")).toBe("2026-02-28");
    expect(nextOccurrence(anchor29, "2026-02-28")).toBe("2026-03-29");
  });

  it("weekly steps 7 days across month and year boundaries", () => {
    const rule = { frequency: "weekly", startDate: "2026-12-24" } as const;
    expect(nextOccurrence(rule, "2026-12-24")).toBe("2026-12-31");
    expect(nextOccurrence(rule, "2026-12-31")).toBe("2027-01-07");
    // `after` between occurrences still lands on the grid, not after+7.
    expect(nextOccurrence(rule, "2026-12-27")).toBe("2026-12-31");
  });

  it("after < startDate returns startDate, weekly and monthly", () => {
    // Must not run k negative. The smallest occurrence strictly after any date
    // before the anchor is the anchor itself.
    const weekly = { frequency: "weekly", startDate: "2026-06-15" } as const;
    expect(nextOccurrence(weekly, "2026-06-14")).toBe("2026-06-15");
    expect(nextOccurrence(weekly, "2020-01-01")).toBe("2026-06-15");
    expect(nextOccurrence(monthly31, "2026-01-30")).toBe("2026-01-31");
    expect(nextOccurrence(monthly31, "2020-01-01")).toBe("2026-01-31");
  });

  it("monthly across a year boundary: 2026-12-31 -> 2027-01-31", () => {
    expect(nextOccurrence(monthly31, "2026-12-31")).toBe("2027-01-31");
  });

  it("returns a date past endDate — termination is the caller's job", () => {
    const rule = {
      frequency: "monthly",
      startDate: "2026-01-15",
      endDate: "2026-03-31",
    } as const;
    expect(nextOccurrence(rule, "2026-03-15")).toBe("2026-04-15");
  });

  it("a clamped date fed back in recovers the anchor (self-healing cursor)", () => {
    // The property that makes storing next_occurrence safe: it is a cache of
    // schedule position, and a wrong value corrects itself on the next step
    // because the anchor — not the cache — is what gets read.
    expect(nextOccurrence(monthly31, "2026-02-28")).toBe("2026-03-31");
  });
});

describe("firstOccurrenceOnOrAfter", () => {
  it("with a past startDate lands on today-or-later", () => {
    const monthly = {
      frequency: "monthly",
      startDate: "2025-03-10",
    } as const;
    // "today" from the rule's perspective — no backfill of missed dates.
    expect(firstOccurrenceOnOrAfter(monthly, "2026-08-24")).toBe("2026-09-10");

    const weekly = { frequency: "weekly", startDate: "2025-03-10" } as const;
    // 2025-03-10 is a Monday; the first Monday on/after 2026-08-24 (itself a
    // Monday, 76 weeks on) is that same day.
    expect(firstOccurrenceOnOrAfter(weekly, "2026-08-24")).toBe("2026-08-24");
  });

  it("a date that is itself an occurrence is returned, not skipped", () => {
    // On-or-after, not strictly-after — the >= / > off-by-one this function
    // exists to encapsulate.
    expect(firstOccurrenceOnOrAfter(monthly31, "2026-03-31")).toBe(
      "2026-03-31",
    );
  });

  it("with a future startDate returns startDate", () => {
    expect(firstOccurrenceOnOrAfter(monthly31, "2026-01-01")).toBe(
      "2026-01-31",
    );
  });
});

describe("occurrencesThrough", () => {
  it("respects endDate inclusive, and returns [] when from > through", () => {
    const rule = {
      frequency: "monthly",
      startDate: "2026-01-15",
      endDate: "2026-03-15",
    } as const;
    // endDate is itself an occurrence: it must appear (inclusive), and the
    // schedule stops there even though `through` reaches further.
    expect(occurrencesThrough(rule, "2026-01-01", "2026-12-31")).toEqual([
      "2026-01-15",
      "2026-02-15",
      "2026-03-15",
    ]);
    expect(occurrencesThrough(rule, "2026-03-01", "2026-01-01")).toEqual([]);
  });

  it("occurrencesThrough(rule, X, X) === [X] when X is an occurrence", () => {
    // Amendment A. Task 14 passes next_occurrence as `from`; if this returns []
    // the generator skips an expense and nothing else notices.
    expect(occurrencesThrough(monthly31, "2026-02-28", "2026-02-28")).toEqual([
      "2026-02-28",
    ]);
  });

  it("a `from` off the schedule snaps forward onto it", () => {
    // A drifted cursor self-corrects: the walk starts from the first real
    // occurrence on or after `from`, not from `from` itself.
    expect(occurrencesThrough(monthly31, "2026-02-01", "2026-04-30")).toEqual([
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
    ]);
  });

  it("weekly catch-up spans a year boundary without gaps", () => {
    const rule = { frequency: "weekly", startDate: "2026-12-24" } as const;
    expect(occurrencesThrough(rule, "2026-12-24", "2027-01-14")).toEqual([
      "2026-12-24",
      "2026-12-31",
      "2027-01-07",
      "2027-01-14",
    ]);
  });

  it("an endDate between occurrences stops at the last one before it", () => {
    // The bound is on the schedule, not the calendar: nothing fires between
    // the 15th and the 20th, so the 20th ends the rule after the 15th.
    const rule = {
      frequency: "monthly",
      startDate: "2026-01-15",
      endDate: "2026-03-20",
    } as const;
    expect(occurrencesThrough(rule, "2026-01-01", "2026-12-31")).toEqual([
      "2026-01-15",
      "2026-02-15",
      "2026-03-15",
    ]);
  });

  it("an endDate before `from` yields nothing", () => {
    const rule = {
      frequency: "weekly",
      startDate: "2026-01-01",
      endDate: "2026-01-15",
    } as const;
    expect(occurrencesThrough(rule, "2026-02-01", "2026-12-31")).toEqual([]);
  });
});
