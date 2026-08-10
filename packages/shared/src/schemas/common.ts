import { z } from "zod";

/**
 * Primitives shared by every schema in this package.
 *
 * These are the wire contract, not the database shape: schemas here are
 * hand-written so the public API can evolve independently of `schema.ts`.
 */

/** UUIDv7 strings, generated in the app layer. */
export const uuid = z.uuid();

/** Single currency in v1 — see the CHECK (currency = 'LKR') on every money table. */
export const currency = z.literal("LKR");

/** `timestamptz` columns serialized by the API; `Date` objects must be stringified first. */
export const timestamp = z.iso.datetime({ offset: true });

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Formats a `Date` from its **UTC** components. The single formatting idiom for
 *  this file: `toISOString().slice(0, 10)` is correct only for dates built with
 *  `Date.UTC`, and two idioms for one operation is how an off-by-one day gets in.
 *
 *  UTC, not local, because these schemas run on both sides of the wire — the
 *  browser in the user's timezone, the API in the server's. A local-time boundary
 *  would let the same input pass in one and fail in the other. */
const toIsoDateUtc = (d: Date): string =>
  `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;

/**
 * True only for dates the calendar actually has. The regex alone accepts
 * "2025-02-31"; `Date.UTC` normalizes it to March 3, so the round-trip
 * comparison is what rejects it.
 */
const isRealCalendarDate = (s: string): boolean => {
  const parts = s.split("-");
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
};

/** Adds whole years to a `YYYY-MM-DD` string. Feb 29 + n years normalizes to Mar 1. */
const addYears = (isoDateString: string, years: number): string => {
  const parts = isoDateString.split("-");
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  return toIsoDateUtc(new Date(Date.UTC(y + years, m - 1, d)));
};

/**
 * Dates cross the wire as `YYYY-MM-DD` — the Postgres `DATE` type, no time
 * component, no timezone to drift at month boundaries.
 */
export const isoDate = z
  .string()
  .regex(ISO_DATE_RE, { message: "date must be formatted YYYY-MM-DD" })
  .refine(isRealCalendarDate, { message: "date is not a real calendar date" });

/** Months cross the wire as `YYYY-MM`. */
export const isoMonth = z
  .string()
  .regex(ISO_MONTH_RE, { message: "month must be formatted YYYY-MM" });

/**
 * Money is integer minor units (LKR cents), never a float and never a decimal
 * string. `z.int()` also bounds the value to JavaScript's safe-integer range
 * (±2^53 - 1): Postgres `bigint` is wider, but a value past 2^53 - 1 cannot
 * round-trip through a JSON number without silently rounding, so the wire
 * contract stops at the ceiling the runtime can represent exactly.
 */
export const moneyMinor = z.int().nonnegative();

/** Expense and recurring-rule amounts: CHECK (amount_minor > 0). */
export const amountMinor = moneyMinor.positive();

/** Today, as `YYYY-MM-DD`. */
export const todayIsoDate = (from: Date = new Date()): string =>
  toIsoDateUtc(from);

/** One year from `from`, as `YYYY-MM-DD`. */
export const plusOneYear = (from: Date = new Date()): string =>
  addYears(todayIsoDate(from), 1);

/**
 * "Future dates allowed, max 1 year ahead" lives here so react-hook-form and
 * the API enforce it with the same code. ISO date strings compare lexically.
 */
export const expenseDate = isoDate.refine((s) => s <= plusOneYear(), {
  message: "date cannot be more than 1 year in the future",
});

/** Longest report window: 5 years. */
const MAX_RANGE_YEARS = 5;

/** `{ from, to }` with the two rules every report route shares. */
export const withRangeRules = <
  T extends z.ZodType<{ from: string; to: string }>,
>(
  schema: T,
) =>
  schema
    .refine((v) => v.from <= v.to, {
      message: "from must not be after to",
      path: ["from"],
    })
    .refine((v) => v.to <= addYears(v.from, MAX_RANGE_YEARS), {
      message: `range must not span more than ${MAX_RANGE_YEARS} years`,
      path: ["to"],
    });
