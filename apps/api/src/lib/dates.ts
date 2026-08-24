/**
 * Calendar arithmetic on `YYYY-MM-DD` and `YYYY-MM` strings — the report
 * ranges and the recurring-occurrence primitives share these.
 *
 * Everything here goes through `Date.UTC` and the UTC getters and nothing else.
 * A `Date` built any other way carries the server's timezone, and a month
 * boundary is precisely where a timezone moves a date by a day: the 31st at
 * 23:00 in one zone is the 1st in another. The wire and the DATE column have
 * no time, so neither does this module — strings in, strings out.
 *
 * `todayUtc` is the single impure function here: it reads the clock. Every
 * other export is string-in/string-out.
 */

export interface DateRange {
  from: string;
  to: string;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

const MS_PER_DAY = 86_400_000;

interface Ymd {
  y: number;
  m: number;
  d: number;
}

/** `YYYY-MM-DD` -> its parts. `YYYY-MM` also parses, with `d` = 1. */
const parse = (s: string): Ymd => {
  const parts = s.split("-");
  return {
    y: Number(parts[0]),
    m: Number(parts[1]),
    d: parts[2] === undefined ? 1 : Number(parts[2]),
  };
};

const toUtc = ({ y, m, d }: Ymd): Date => new Date(Date.UTC(y, m - 1, d));

const formatDate = (dt: Date): string =>
  `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;

const formatMonth = (dt: Date): string =>
  `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}`;

/** `isoDate` plus `days`, as `YYYY-MM-DD`. Negative steps backward. */
export const addDays = (isoDate: string, days: number): string =>
  formatDate(new Date(toUtc(parse(isoDate)).getTime() + days * MS_PER_DAY));

/** Whole days from `from` to `to`; negative when `to` precedes `from`. */
export function daysBetween(from: string, to: string): number {
  return Math.round(
    (toUtc(parse(to)).getTime() - toUtc(parse(from)).getTime()) / MS_PER_DAY,
  );
}

/**
 * Days in the month of a `YYYY-MM` or `YYYY-MM-DD`.
 *
 * `Date.UTC(y, m, 0)` is "day zero of the following month", which the runtime
 * normalizes to the last day of this one — February and its leap years
 * included, with no table of month lengths to keep correct.
 */
export function daysInMonth(month: string): number {
  const { y, m } = parse(month);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** `YYYY-MM` plus `k` months, as `YYYY-MM`. Negative steps backward. */
export function addMonths(month: string, k: number): string {
  const { y, m } = parse(month);
  return formatMonth(toUtc({ y, m: m + k, d: 1 }));
}

/** Today in UTC as `YYYY-MM-DD`. The generator's calendar; see the brief. */
export const todayUtc = (): string => new Date().toISOString().slice(0, 10);

/**
 * The first and last day of a `YYYY-MM` month.
 *
 * The last day is "day 0 of the following month": `Date.UTC` normalizes it,
 * which is how February's length — leap years included — comes out without a
 * table of month lengths.
 */
export function monthRange(month: string): DateRange {
  const { y, m } = parse(month);
  return {
    from: formatDate(toUtc({ y, m, d: 1 })),
    to: formatDate(new Date(Date.UTC(y, m, 0))),
  };
}

/**
 * The period of equal length ending the day before `from`.
 *
 * "Equal length" is a day count, not a month count: the previous period of a
 * 28-day February is the 28 days before it, which is most of January rather
 * than all of it. Comparing a month to the previous month by name would read
 * differently but is not what `prevPeriodTotalMinor` claims to be — the range
 * endpoints accept arbitrary spans, and a day count is the only definition that
 * means the same thing for all of them.
 */
export function prevPeriod(from: string, to: string): DateRange {
  const lengthDays = daysBetween(from, to);
  const prevTo = addDays(from, -1);
  return { from: addDays(prevTo, -lengthDays), to: prevTo };
}

/**
 * Every `YYYY-MM` from the month of `from` through the month of `to`.
 *
 * This is the trend's x-axis: the aggregate returns only months with rows, and
 * a month with nothing in it must still appear with a zero, or a chart draws a
 * line straight across the gap. Empty when `from > to` — there is no range.
 */
export function monthsBetween(from: string, to: string): string[] {
  if (from > to) return [];
  const start = parse(from);
  const end = parse(to);
  const months: string[] = [];
  for (
    let y = start.y, m = start.m;
    y < end.y || (y === end.y && m <= end.m);
  ) {
    months.push(formatMonth(toUtc({ y, m, d: 1 })));
    if (m === 12) {
      y += 1;
      m = 1;
    } else {
      m += 1;
    }
  }
  return months;
}
