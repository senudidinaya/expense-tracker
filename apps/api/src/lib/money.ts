/**
 * The exact-integer ceiling, in one place (design/api.md, "Aggregated money
 * and the exact-integer ceiling").
 *
 * `sum(amount_minor)` over `bigint` comes back from Postgres as `numeric`,
 * which can carry a value far past what a JS number represents exactly. The
 * rule for every endpoint that aggregates money is the same: keep the sum as
 * text, range-check it, and only then convert — read it as a number first and
 * the evidence of the overflow is already gone.
 *
 * Six response fields across five endpoints apply this; they all call here so
 * that they cannot decide it six slightly different ways.
 */

/**
 * The exact integer a Postgres numeric-as-text denotes, or `null` when it is
 * past 2^53 - 1 and no JS number can hold it exactly.
 *
 * `Number()` rounds a too-large string to the nearest double, and every double
 * at or above 2^53 fails `isSafeInteger` — so the rounding cannot produce a
 * false pass. A value the check accepts is the value the text said.
 */
export function exactMinorOrNull(numericText: string): number | null {
  const n = Number(numericText);
  return Number.isSafeInteger(n) ? n : null;
}
