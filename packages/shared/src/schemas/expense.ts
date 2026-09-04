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

/**
 * What "filter the expenses" means, in one place.
 *
 * The list and the CSV export take the same filters — design/api.md says so of
 * the export in as many words — and the only way two endpoints stay honest
 * about that is to share the schema rather than to each declare their own copy
 * of four optional fields. Pagination is what differs, so pagination is what
 * gets added on top.
 */
export const expenseFiltersQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  categoryIds: z
    .string()
    .transform((s) => s.split(","))
    .pipe(z.array(uuid).max(MAX_CATEGORY_FILTERS))
    .optional(),
  q: z.string().max(100).optional(),
});

export const listExpensesQuery = expenseFiltersQuery.extend({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/**
 * The export streams every matching row, so it has no cursor and no limit —
 * it is the filters and nothing else. Unknown keys are stripped (zod default),
 * so a client that sends `limit` gets the whole file rather than an error.
 */
export const exportExpensesQuery = expenseFiltersQuery;

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

/**
 * Output. The envelope every single-expense route answers with — `POST` and
 * `PATCH` today.
 *
 * It lives here rather than in each app because it *is* the contract, and two
 * hand-written copies of the same wrapper is precisely the drift this package
 * exists to prevent: the API declared its 201/200 shape and the web app
 * declared what it parses, and nothing but attention kept the two the same.
 * Wrapping in an object rather than returning the expense bare is what leaves
 * room to add a sibling field later without it being a breaking change.
 */
export const expenseResponse = z.object({ expense: expenseDto });

/** Totals are computed in SQL under the same filters, and only on the first page. */
export const listExpensesResponse = z.object({
  items: z.array(expenseDto),
  nextCursor: z.string().nullable(),
  totalCount: z.int().nonnegative().optional(),
  totalAmountMinor: z.int().nonnegative().optional(),
});

export type ExpenseResponse = z.infer<typeof expenseResponse>;
export type CreateExpenseBody = z.infer<typeof createExpenseBody>;
export type PatchExpenseBody = z.infer<typeof patchExpenseBody>;
export type ExpenseFiltersQuery = z.infer<typeof expenseFiltersQuery>;
export type ListExpensesQuery = z.infer<typeof listExpensesQuery>;
export type ExportExpensesQuery = z.infer<typeof exportExpensesQuery>;
export type Expense = z.infer<typeof expenseDto>;
export type ListExpensesResponse = z.infer<typeof listExpensesResponse>;
