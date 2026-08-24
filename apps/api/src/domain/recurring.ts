/**
 * Recurring-occurrence math, as pure functions on `YYYY-MM-DD` strings.
 *
 * design/schema.md: the next occurrence is always computed from the anchor
 * day-of-month in `start_date`, never by incrementing the previously clamped
 * date — incrementing the clamped date drifts permanently
 * (Jan 31 -> Feb 28 -> Mar 28 -> ...). Deriving from the anchor every time
 * also makes the stored `next_occurrence` self-healing: it is a cache of
 * schedule position, and a wrong value corrects itself on the next step.
 */

import type { RecurringFrequency } from "@expense/shared";
import { addDays, addMonths, daysBetween, daysInMonth } from "../lib/dates.js";

/**
 * The slice of a rule the math reads. `endDate` is `string | null` so a repo
 * row — Postgres returns the nullable DATE column as exactly that — drops
 * straight in with no cast.
 */
export interface Schedule {
  frequency: RecurringFrequency;
  startDate: string;
  endDate?: string | null;
}

/**
 * The occurrence in `month` for an anchor day: the anchor, clamped to the
 * month's length. Note what this does NOT read — the previous occurrence.
 * Stepping from a clamped date loses the anchor permanently
 * (Jan 31 -> Feb 28 -> Mar 28 -> ...); deriving from the anchor recovers it.
 */
const occurrenceIn = (month: string, anchorDay: number): string =>
  `${month}-${String(Math.min(anchorDay, daysInMonth(month))).padStart(2, "0")}`;

/**
 * Weekly occurrences are `startDate + 7k`. With `d = daysBetween(start, after)`
 * (here always >= 0 — the caller handled `after < startDate`),
 * `floor(d / 7)` is the last step at or before `after`, so `+ 1` is the first
 * one strictly after it. That holds on the grid too: when `after` is itself an
 * occurrence, `d / 7` is exact and `+ 1` moves past it rather than returning it.
 */
const nextWeekly = (startDate: string, after: string): string =>
  addDays(startDate, (Math.floor(daysBetween(startDate, after) / 7) + 1) * 7);

/**
 * Two candidates, never a loop from k = 0: the occurrence in `after`'s own
 * month either follows `after` or it does not, and the next month's always
 * does. A rule anchored in 2019 costs what one anchored yesterday costs.
 */
const nextMonthly = (startDate: string, after: string): string => {
  const anchorDay = Number(startDate.slice(8, 10));
  const month = after.slice(0, 7);
  const candidate = occurrenceIn(month, anchorDay);
  return candidate > after
    ? candidate
    : occurrenceIn(addMonths(month, 1), anchorDay);
};

/**
 * The smallest occurrence strictly greater than `after`.
 *
 * `endDate` is deliberately not read here: this is an infinite sequence and
 * always has a next element. Bounding it is `occurrencesThrough`'s job.
 */
export function nextOccurrence(rule: Schedule, after: string): string {
  if (after < rule.startDate) return rule.startDate;
  return rule.frequency === "weekly"
    ? nextWeekly(rule.startDate, after)
    : nextMonthly(rule.startDate, after);
}

/** The smallest occurrence on or after `date` — `nextOccurrence` shifted by a day. */
export const firstOccurrenceOnOrAfter = (
  rule: Schedule,
  date: string,
): string => nextOccurrence(rule, addDays(date, -1));

/**
 * Every occurrence in `[from, through]`, both bounds INCLUSIVE, stopping at
 * `endDate` if the rule has one.
 *
 * `from` inclusive is load-bearing: Task 14 passes `next_occurrence`, which is
 * a date that must be generated. Starting from `firstOccurrenceOnOrAfter`
 * rather than assuming `from` is itself an occurrence also snaps a cursor that
 * has drifted back onto the schedule.
 */
export function occurrencesThrough(
  rule: Schedule,
  from: string,
  through: string,
): string[] {
  const limit =
    rule.endDate == null || through < rule.endDate ? through : rule.endDate;
  const out: string[] = [];
  for (
    let occ = firstOccurrenceOnOrAfter(rule, from);
    occ <= limit;
    occ = nextOccurrence(rule, occ)
  ) {
    out.push(occ);
  }
  return out;
}
