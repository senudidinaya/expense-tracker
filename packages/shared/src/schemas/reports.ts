import { z } from "zod";
import {
  isoDate,
  isoMonth,
  moneyMinor,
  uuid,
  withRangeRules,
} from "./common.js";
import { expenseDto } from "./expense.js";

/**
 * Every range report shares one query shape and one pair of rules
 * (`from <= to`, span <= 5 years), so a route cannot accidentally accept a
 * range the others reject.
 */
export const reportRangeQuery = withRangeRules(
  z.object({
    from: isoDate,
    to: isoDate,
  }),
);

/** Budget status is asked per month, not per range. */
export const budgetStatusQuery = z.object({
  month: isoMonth,
});

/**
 * A money field that is a *sum* of rows. Per design/api.md ("Aggregated money
 * and the exact-integer ceiling"): each row is capped at 2^53 - 1, nothing
 * caps a sum of legal rows, and past the ceiling the field is omitted rather
 * than rounded. Optional, then, means "no exact answer exists" — never "not
 * computed". Counts and ratios are not sums and are never omitted.
 */
const aggregatedMinor = moneyMinor.optional();

/**
 * Output. `avgMinor` is the one non-integer money value in the contract: it is
 * a computed statistic, not an amount anything is ever charged, so rounding it
 * to minor units would report a total that does not match the sum. It is never
 * omitted: an average of capped rows cannot exceed the cap.
 * `deltaPct` is null when the previous period had no spending — the change from
 * zero has no percentage, and 0 would read as "no change".
 */
export const summaryResponse = z.object({
  totalMinor: aggregatedMinor,
  count: z.int().nonnegative(),
  avgMinor: z.number().nonnegative(),
  prevPeriodTotalMinor: aggregatedMinor,
  deltaPct: z.number().nullable(),
});

/**
 * `share` is a fraction of the range total, so it is bounded by 1. Shares sum
 * to 1 whenever `items` is non-empty; a range with no spending has no items,
 * not items with a 0/0 share.
 */
export const byCategoryResponse = z.object({
  items: z.array(
    z.object({
      categoryId: uuid,
      totalMinor: aggregatedMinor,
      share: z.number().min(0).max(1),
    }),
  ),
});

/** Months, not dates: the trend buckets by calendar month and is zero-filled. */
export const trendResponse = z.object({
  items: z.array(
    z.object({
      month: isoMonth,
      totalMinor: aggregatedMinor,
    }),
  ),
});

/**
 * Output. Unbudgeted categories carry `budgetMinor: null`, and with no budget
 * there is nothing to remain or be a percentage of — `pct` is also null for a
 * budget of 0, which has no percentage either. `remainingMinor` goes negative
 * on overspend and `pct` past 1 — both are the point of the report, so neither
 * is clamped.
 *
 * `spentMinor` is a sum and follows the ceiling rule; `remainingMinor` and
 * `pct` are derived from it and are omitted with it. `budgetMinor` is a single
 * stored row and is always present.
 */
export const budgetStatusResponse = z.object({
  items: z.array(
    z.object({
      categoryId: uuid,
      budgetMinor: moneyMinor.nullable(),
      spentMinor: aggregatedMinor,
      remainingMinor: z.int().nullable().optional(),
      pct: z.number().nonnegative().nullable().optional(),
    }),
  ),
});

/** Same range rules as every other report, plus its own limit. */
export const topExpensesQuery = withRangeRules(
  z.object({
    from: isoDate,
    to: isoDate,
    limit: z.coerce.number().int().min(1).max(20).default(5),
  }),
);

export const topExpensesResponse = z.object({
  items: z.array(expenseDto),
});

export type ReportRangeQuery = z.infer<typeof reportRangeQuery>;
export type BudgetStatusQuery = z.infer<typeof budgetStatusQuery>;
export type SummaryResponse = z.infer<typeof summaryResponse>;
export type ByCategoryResponse = z.infer<typeof byCategoryResponse>;
export type TrendResponse = z.infer<typeof trendResponse>;
export type BudgetStatusResponse = z.infer<typeof budgetStatusResponse>;
export type TopExpensesQuery = z.infer<typeof topExpensesQuery>;
export type TopExpensesResponse = z.infer<typeof topExpensesResponse>;
