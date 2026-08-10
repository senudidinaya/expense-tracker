import { z } from "zod";
import {
  amountMinor,
  currency,
  expenseDate,
  isoDate,
  timestamp,
  uuid,
} from "./common.js";

const description = z.string().min(1).max(200);
const notes = z.string().max(2000);

/**
 * Input. No `id`, no `userId`, no timestamps: all four are server-derived, and
 * zod's default strip means a client that sends them gets them dropped rather
 * than smuggled into a repository call.
 */
export const createExpenseBody = z.object({
  amountMinor,
  categoryId: uuid,
  date: expenseDate,
  description,
  notes: notes.optional(),
});

/** Input. Every field optional; the id travels in the path, never the body. */
export const patchExpenseBody = createExpenseBody.partial();

/** No user has 50 categories, so the cap costs nothing real. Every other
 *  parameter here is bounded (`limit` at 100, `q` at 100 chars); an unbounded
 *  list is a cheap request that becomes a large `IN` clause, and the body-size
 *  limit does not apply to a query string. */
const MAX_CATEGORY_FILTERS = 50;

export const listExpensesQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  categoryIds: z
    .string()
    .transform((s) => s.split(","))
    .pipe(z.array(uuid).max(MAX_CATEGORY_FILTERS))
    .optional(),
  q: z.string().max(100).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** Output. */
export const expenseDto = z.object({
  id: uuid,
  categoryId: uuid,
  recurringRuleId: uuid.nullable(),
  amountMinor,
  currency,
  date: isoDate,
  description: z.string(),
  notes: z.string().nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

/** Totals are computed in SQL under the same filters, and only on the first page. */
export const listExpensesResponse = z.object({
  items: z.array(expenseDto),
  nextCursor: z.string().nullable(),
  totalCount: z.int().nonnegative().optional(),
  totalAmountMinor: z.int().nonnegative().optional(),
});

export type CreateExpenseBody = z.infer<typeof createExpenseBody>;
export type PatchExpenseBody = z.infer<typeof patchExpenseBody>;
export type ListExpensesQuery = z.infer<typeof listExpensesQuery>;
export type Expense = z.infer<typeof expenseDto>;
export type ListExpensesResponse = z.infer<typeof listExpensesResponse>;
