import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { categories, expenses } from "../db/schema.js";
import { monthRange, monthsBetween, prevPeriod } from "../lib/dates.js";
import { exactMinorOrNull } from "../lib/money.js";
import { budgetsRepo } from "./budgets.js";
import { expenseColumns, type ExpenseRecord } from "./expenses.js";

/**
 * The reports. design/api.md: all aggregation in SQL (`SUM`/`GROUP BY` over
 * `amount_minor`), never in JS. Nothing in this file adds two amounts
 * together; what JS does here is shape rows, zero-fill a series from a list of
 * months, and match two result sets by category id — none of which is a sum.
 *
 * Every sum is `coalesce(sum(amount_minor), 0)` cast to text and passed
 * through `exactMinorOrNull`, the ceiling rule from design/api.md. A `null`
 * from it means "no exact integer exists", and the route omits the field.
 *
 * The overflow inventory, field by field, is in the comment on each method.
 * The short version: anything that is a sum of rows can overflow and is
 * nullable here; anything that is a count, a single stored row, or a ratio
 * computed in SQL from the exact sums cannot, and never is.
 */

export interface SummaryReport {
  /** `null` past the ceiling. */
  totalMinor: number | null;
  count: number;
  /** A statistic, not an amount: fractional, and computed by Postgres from
   *  the rows — never from `totalMinor`. 0 for an empty range. */
  avgMinor: number;
  /** `null` past the ceiling. */
  prevPeriodTotalMinor: number | null;
  /** `null` when the previous period had no spending. */
  deltaPct: number | null;
}

export interface CategoryShare {
  categoryId: string;
  /** `null` past the ceiling. */
  totalMinor: number | null;
  /** This category's fraction of the range total, computed in SQL. */
  share: number;
}

export interface TrendPoint {
  /** `YYYY-MM`. */
  month: string;
  /** `null` past the ceiling. */
  totalMinor: number | null;
}

export interface BudgetStatusLine {
  categoryId: string;
  /** `null` when unbudgeted — never set, or cleared. */
  budgetMinor: number | null;
  /** `null` past the ceiling; `remainingMinor` and `pct` go with it. */
  spentMinor: number | null;
  /** `null` when unbudgeted or when `spentMinor` is `null`. */
  remainingMinor: number | null;
  /** `null` when unbudgeted, when the budget is 0, or when `spentMinor` is. */
  pct: number | null;
}

/** `user_id` first and unconditional, then the inclusive date window. */
const inRange = (userId: string, from: string, to: string) =>
  and(
    eq(expenses.userId, userId),
    gte(expenses.date, from),
    lte(expenses.date, to),
  );

export const reportsRepo = {
  /**
   * Totals for the range and for the period of equal length just before it,
   * in one pass over the union of the two windows.
   *
   * Overflow: `totalMinor` and `prevPeriodTotalMinor` are sums and can.
   * `count` is bounded by the row count. `avgMinor` cannot exceed the largest
   * row, and every row is capped at the ceiling. `deltaPct` is computed in SQL
   * from the exact numerics, so it stays correct even when one or both sums
   * are too large to be returned — the ratio of two huge numbers is a small
   * one. The two `FILTER` clauses read the same rows once rather than running
   * the summary twice.
   */
  async summary(
    db: Db,
    userId: string,
    from: string,
    to: string,
  ): Promise<SummaryReport> {
    const prev = prevPeriod(from, to);
    const current = sql`${expenses.date} between ${from} and ${to}`;
    const previous = sql`${expenses.date} between ${prev.from} and ${prev.to}`;

    const sums = db
      .select({
        total:
          sql`coalesce(sum(${expenses.amountMinor}) filter (where ${current}), 0)`.as(
            "total",
          ),
        count: sql`count(*) filter (where ${current})`.as("count"),
        avg: sql`coalesce(avg(${expenses.amountMinor}) filter (where ${current}), 0)`.as(
          "avg",
        ),
        prev: sql`coalesce(sum(${expenses.amountMinor}) filter (where ${previous}), 0)`.as(
          "prev",
        ),
      })
      .from(expenses)
      .where(inRange(userId, prev.from, to))
      .as("sums");

    const [row] = await db
      .select({
        totalText: sql<string>`${sums.total}::text`,
        count: sql<number>`${sums.count}`.mapWith(Number),
        avg: sql<number>`${sums.avg}::float8`.mapWith(Number),
        prevText: sql<string>`${sums.prev}::text`,
        deltaPct: sql<
          number | null
        >`case when ${sums.prev} = 0 then null else ((${sums.total} - ${sums.prev}) / ${sums.prev})::float8 end`,
      })
      .from(sums);

    // An aggregate with no GROUP BY always yields one row; the fallback is for
    // `noUncheckedIndexedAccess`, not for a case that can happen.
    if (!row) {
      return {
        totalMinor: 0,
        count: 0,
        avgMinor: 0,
        prevPeriodTotalMinor: 0,
        deltaPct: null,
      };
    }

    return {
      totalMinor: exactMinorOrNull(row.totalText),
      count: row.count,
      avgMinor: row.avg,
      prevPeriodTotalMinor: exactMinorOrNull(row.prevText),
      deltaPct: row.deltaPct,
    };
  },

  /**
   * Per-category totals with each category's share of the range total,
   * largest first. Categories with no spending in the range are not rows.
   *
   * `share` is `sum / sum(sum) over ()` — the window over the grouped sums is
   * what lets one query produce both numbers. It cannot divide by zero: every
   * row has `amount_minor > 0`, so any group that exists has a positive total
   * and so does the whole. A range with no spending yields no groups at all,
   * which is the answer to "what do shares sum to when nothing was spent" —
   * there are none. Both sum and share are exact `numeric` in Postgres; only
   * the share is cast to a float, because only the share is allowed to be one.
   *
   * Overflow: `totalMinor` is a sum and can. `share` is a ratio and cannot.
   */
  async byCategory(
    db: Db,
    userId: string,
    from: string,
    to: string,
  ): Promise<CategoryShare[]> {
    const total = sql`sum(${expenses.amountMinor})`;
    const rows = await db
      .select({
        categoryId: expenses.categoryId,
        totalText: sql<string>`${total}::text`,
        share: sql<number>`(${total} / sum(${total}) over ())::float8`.mapWith(
          Number,
        ),
      })
      .from(expenses)
      .where(inRange(userId, from, to))
      .groupBy(expenses.categoryId)
      .orderBy(desc(total), expenses.categoryId);

    return rows.map((r) => ({
      categoryId: r.categoryId,
      totalMinor: exactMinorOrNull(r.totalText),
      share: r.share,
    }));
  },

  /**
   * Monthly totals over the range, one point per calendar month the range
   * touches, zero-filled.
   *
   * The GROUP BY is on `date_trunc('month', date)` in SQL. The zero-fill is
   * in JS from `monthsBetween`, which is not aggregation: the aggregate has
   * nothing to say about a month with no rows, and a chart needs the month
   * there with a 0 rather than a gap. A partial month at either end is still
   * bounded by `from`/`to` — the bucket is the month, the rows are the range.
   *
   * Overflow: `totalMinor` is a sum and can, per month.
   */
  async trend(
    db: Db,
    userId: string,
    from: string,
    to: string,
  ): Promise<TrendPoint[]> {
    const month = sql<string>`to_char(date_trunc('month', ${expenses.date}), 'YYYY-MM')`;
    const rows = await db
      .select({
        month,
        totalText: sql<string>`coalesce(sum(${expenses.amountMinor}), 0)::text`,
      })
      .from(expenses)
      .where(inRange(userId, from, to))
      .groupBy(month);

    const byMonth = new Map(rows.map((r) => [r.month, r.totalText]));
    return monthsBetween(from, to).map((m) => {
      const text = byMonth.get(m);
      return {
        month: m,
        totalMinor: text === undefined ? 0 : exactMinorOrNull(text),
      };
    });
  },

  /**
   * Every one of the user's active categories, with the budget in effect for
   * `month` and what was spent against it.
   *
   * Two reads, matched by category id in JS:
   *
   *  - Spend comes from `categories LEFT JOIN expenses`, and the outer join is
   *    the point. A category that is budgeted but untouched this month is the
   *    budget going unspent — the row a user most wants to see — and an inner
   *    join would drop exactly that row. `coalesce(sum, 0)` is what turns the
   *    absent spend into a 0. An archived category is listed only if it has
   *    spend this month: its history is still real, but an empty archived
   *    category is noise.
   *  - Budgets come from `budgetsRepo.effectiveForMonth`, which resolves the
   *    effective-from rule through `domain/budgets.ts`. Resolving it again in
   *    SQL here would be a second opinion on the same rule, and the two would
   *    eventually disagree. A cleared budget and a never-set one are both
   *    "unbudgeted" to this report.
   *
   * Matching by id is not aggregation: nothing is added, each category's one
   * spend meets its one budget.
   *
   * Overflow: `spentMinor` is a sum and can. `budgetMinor` is one stored row,
   * capped by the wire schema, and cannot. `remainingMinor = budget - spent`
   * is within ±(2^53 - 1) exactly when `spent` is, so it is exact whenever it
   * is computed and is withheld when `spent` is. `pct = spent / budget` is a
   * statistic, but its inputs come from two queries, so it is computed here
   * from the exact `spent` — and withheld with it rather than estimated from
   * a rounded one. `null` for a budget of 0: overspend of nothing has no
   * percentage, and `remainingMinor` already says how far over.
   */
  async budgetStatus(
    db: Db,
    userId: string,
    month: string,
  ): Promise<BudgetStatusLine[]> {
    const { from, to } = monthRange(month);

    const [spendRows, budgets] = await Promise.all([
      db
        .select({
          categoryId: categories.id,
          spentText: sql<string>`coalesce(sum(${expenses.amountMinor}), 0)::text`,
        })
        .from(categories)
        .leftJoin(
          expenses,
          and(
            eq(expenses.categoryId, categories.id),
            // Redundant with the category's ownership, but it is the leading
            // column of `expenses_user_cat_date_idx`, which this join then
            // uses in full.
            eq(expenses.userId, categories.userId),
            gte(expenses.date, from),
            lte(expenses.date, to),
          ),
        )
        .where(eq(categories.userId, userId))
        .groupBy(categories.id, categories.name)
        .having(
          sql`${categories.archivedAt} is null or count(${expenses.id}) > 0`,
        )
        .orderBy(categories.name, categories.id),
      budgetsRepo.effectiveForMonth(db, userId, month),
    ]);

    const budgetFor = new Map(
      budgets.map((b) => [b.categoryId, b.amountMinor]),
    );

    return spendRows.map((r) => {
      const budgetMinor = budgetFor.get(r.categoryId) ?? null;
      const spentMinor = exactMinorOrNull(r.spentText);
      if (spentMinor === null) {
        return {
          categoryId: r.categoryId,
          budgetMinor,
          spentMinor: null,
          remainingMinor: null,
          pct: null,
        };
      }
      return {
        categoryId: r.categoryId,
        budgetMinor,
        spentMinor,
        remainingMinor: budgetMinor === null ? null : budgetMinor - spentMinor,
        pct:
          budgetMinor === null || budgetMinor === 0
            ? null
            : spentMinor / budgetMinor,
      };
    });
  },

  /**
   * The `limit` largest expenses in the range, whole rows, largest first.
   * Ties break newest first, then by id, so the order is total and a page of
   * equal amounts is the same page every time.
   *
   * Overflow: nothing here is aggregated — each `amountMinor` is one row,
   * already within the ceiling by the per-row cap.
   */
  async topExpenses(
    db: Db,
    userId: string,
    from: string,
    to: string,
    limit: number,
  ): Promise<ExpenseRecord[]> {
    return db
      .select(expenseColumns)
      .from(expenses)
      .where(inRange(userId, from, to))
      .orderBy(
        desc(expenses.amountMinor),
        desc(expenses.date),
        desc(expenses.id),
      )
      .limit(limit);
  },
};
