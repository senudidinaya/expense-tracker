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
 * Output. `avgMinor` is the one non-integer money value in the contract: it is
 * a computed statistic, not an amount anything is ever charged, so rounding it
 * to minor units would report a total that does not match the sum.
 * `deltaPct` is null when the previous period had no spending — the change from
 * zero has no percentage, and 0 would read as "no change".
 */
export const summaryResponse = z.object({
  totalMinor: moneyMinor,
  count: z.int().nonnegative(),
  avgMinor: z.number().nonnegative(),
  prevPeriodTotalMinor: moneyMinor,
  deltaPct: z.number().nullable(),
});

/** `share` is a fraction of the range total, so it is bounded by 1. */
export const byCategoryResponse = z.object({
  items: z.array(
    z.object({
      categoryId: uuid,
      totalMinor: moneyMinor,
      share: z.number().min(0).max(1),
    }),
  ),
});

/** Months, not dates: the trend buckets by calendar month and is zero-filled. */
export const trendResponse = z.object({
  items: z.array(
    z.object({
      month: isoMonth,
      totalMinor: moneyMinor,
    }),
  ),
});

/**
 * Output. Unbudgeted categories carry `budgetMinor: null`, and with no budget
 * there is nothing to remain or be a percentage of. `remainingMinor` goes
 * negative on overspend and `pct` past 1 — both are the point of the report,
 * so neither is clamped.
 */
export const budgetStatusResponse = z.object({
  items: z.array(
    z.object({
      categoryId: uuid,
      budgetMinor: moneyMinor.nullable(),
      spentMinor: moneyMinor,
      remainingMinor: z.int().nullable(),
      pct: z.number().nonnegative().nullable(),
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
