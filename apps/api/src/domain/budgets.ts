/**
 * The effective-from budget model, as pure functions over rows someone else
 * fetched.
 *
 * design/schema.md: a budget row says "from this month on, this category's
 * budget is X" — or, with a NULL amount, "from this month on, there is none".
 * Nothing expires a row but a later one, and setting or clearing writes exactly
 * one row at one month: history is never rewritten.
 *
 * The rule lives here rather than only in SQL so it can be tested without a
 * database and so the two places that need it — `GET /api/budgets` and Task
 * 12's budget-status report — resolve it identically.
 */

/**
 * One budget row, reduced to the two columns the rule reads.
 *
 * `monthStart` is the DATE column verbatim, `YYYY-MM-DD`, pinned to the 1st by
 * `CHECK (extract(day from month_start) = 1)`. Only the month carries meaning,
 * so the day is dropped on the way in rather than the column being reshaped:
 * one conversion, at the one place that compares.
 */
export interface BudgetRow {
  monthStart: string;
  /** Integer minor units, or NULL for "cleared from this month forward". */
  amountMinor: number | null;
}

/** The answer for one category in one month. */
export interface EffectiveBudget {
  /** `null` means unbudgeted — but a *recorded* unbudgeted; see below. */
  amountMinor: number | null;
  /** `YYYY-MM` of the row this answer came from. */
  effectiveFrom: string;
}

/** `YYYY-MM-DD` -> `YYYY-MM`. Both forms compare lexically, which is why the
 *  rule needs no date arithmetic at all. */
const monthOf = (isoDate: string): string => isoDate.slice(0, 7);

/**
 * The row in effect for `month`: the greatest `monthStart <= month`.
 *
 * Two distinct "unbudgeted" answers come out of this, and they are not
 * interchangeable:
 *
 *  - `{ amountMinor: null, effectiveFrom }` — a row exists saying the budget
 *    was cleared, and the month it was cleared in is part of the answer.
 *  - `null` — no row at or before `month` at all. There is no decision to
 *    report and no month to attach to it.
 *
 * Both render as "unbudgeted" to a user, so it is tempting to collapse them.
 * Doing so would either lose the provenance of a deliberate clear or invent an
 * `effectiveFrom` for a category nobody ever budgeted; the distinction survives
 * all the way to the API, where a cleared category is an item with a null
 * amount and a never-budgeted one is not an item at all.
 *
 * `rows` may arrive in any order. The repository's query happens to sort them,
 * but a scan for the maximum costs the same as trusting that and does not
 * become wrong when a query plan changes. Rows after `month` are ignored: a
 * budget set for June says nothing about April.
 */
export function resolveEffective(
  rows: readonly BudgetRow[],
  month: string,
): EffectiveBudget | null {
  let winner: BudgetRow | null = null;

  for (const row of rows) {
    if (monthOf(row.monthStart) > month) continue;
    if (winner === null || row.monthStart > winner.monthStart) winner = row;
  }

  return winner === null
    ? null
    : {
        amountMinor: winner.amountMinor,
        effectiveFrom: monthOf(winner.monthStart),
      };
}

/** `YYYY-MM` -> the `YYYY-MM-DD` the DATE column stores: the 1st of that month. */
export const monthStartOf = (month: string): string => `${month}-01`;

/** The inverse, for the wire: a stored `month_start` as the month it means. */
export const monthOfStart = monthOf;
