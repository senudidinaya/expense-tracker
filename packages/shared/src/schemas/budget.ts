import { z } from "zod";
import { currency, isoMonth, moneyMinor, timestamp, uuid } from "./common.js";

/**
 * Input. `amountMinor: null` clears the budget from this month forward, so the
 * key is required — an absent key would be indistinguishable from "leave it
 * alone", which this endpoint does not offer.
 *
 * Budgets speak months, not dates, on the wire: `month_start` is a DATE column
 * pinned to the 1st, and `YYYY-MM` is the only part of it that carries meaning.
 */
export const budgetPutBody = z.object({
  categoryId: uuid,
  month: isoMonth,
  amountMinor: moneyMinor.nullable(),
});

export const budgetsGetQuery = z.object({
  month: isoMonth,
});

/** Output. */
export const budgetDto = z.object({
  id: uuid,
  categoryId: uuid,
  month: isoMonth,
  amountMinor: moneyMinor.nullable(),
  currency,
  createdAt: timestamp,
  updatedAt: timestamp,
});

/**
 * Output. The *effective* budget per active category for the requested month:
 * the row with the greatest `month_start <= month`. `amountMinor: null` (or no
 * row at all) means unbudgeted.
 */
export const effectiveBudgetDto = z.object({
  categoryId: uuid,
  amountMinor: moneyMinor.nullable(),
  effectiveFrom: isoMonth,
});

export const budgetsGetResponse = z.object({
  items: z.array(effectiveBudgetDto),
});

export type BudgetPutBody = z.infer<typeof budgetPutBody>;
export type BudgetsGetQuery = z.infer<typeof budgetsGetQuery>;
export type Budget = z.infer<typeof budgetDto>;
export type EffectiveBudget = z.infer<typeof effectiveBudgetDto>;
export type BudgetsGetResponse = z.infer<typeof budgetsGetResponse>;
