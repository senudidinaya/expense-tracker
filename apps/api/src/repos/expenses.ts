import type { CreateExpenseBody, PatchExpenseBody } from "@expense/shared";
import { and, desc, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { categories, expenses } from "../db/schema.js";
import { encodeCursor, type Cursor } from "../lib/cursor.js";
import { newId } from "../lib/ids.js";

/** Everything a caller outside this file may know about an expense. */
export interface ExpenseRecord {
  id: string;
  categoryId: string;
  recurringRuleId: string | null;
  /** Integer minor units. Never a float, never a decimal string. */
  amountMinor: number;
  /** Fixed by `CHECK (currency = 'LKR')`; see `$type` on the column. */
  currency: "LKR";
  /** `YYYY-MM-DD` — the Postgres `DATE` type, no time and no timezone. */
  date: string;
  description: string;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Selected explicitly so `user_id` never rides along into a response. */
const expenseColumns = {
  id: expenses.id,
  categoryId: expenses.categoryId,
  recurringRuleId: expenses.recurringRuleId,
  amountMinor: expenses.amountMinor,
  currency: expenses.currency,
  date: expenses.date,
  description: expenses.description,
  notes: expenses.notes,
  createdAt: expenses.createdAt,
  updatedAt: expenses.updatedAt,
} as const;

export type ExpenseResult =
  | { ok: true; expense: ExpenseRecord }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "category_not_found" }
  | { ok: false; reason: "category_archived" };

type CategoryCheck = "ok" | "category_not_found" | "category_archived";

/**
 * design/api.md: an expense's category must be one the user owns and it must be
 * active. The two failures are kept apart because they are different answers —
 * a category that is not the user's is 404 (existence is not leaked), one that
 * is theirs but archived is 400 (they can see it, they just cannot file new
 * spending under it).
 *
 * Deliberately not inside a transaction with the write that follows. A category
 * archived in the gap would only mean an expense filed a moment before the
 * archive, which is a state the app allows anyway — archiving never invalidates
 * existing expenses, and they stay in filters and reports.
 */
async function categoryUsable(
  db: Db,
  userId: string,
  categoryId: string,
): Promise<CategoryCheck> {
  const [row] = await db
    .select({ archivedAt: categories.archivedAt })
    .from(categories)
    .where(and(eq(categories.userId, userId), eq(categories.id, categoryId)))
    .limit(1);

  if (!row) return "category_not_found";
  return row.archivedAt === null ? "ok" : "category_archived";
}

/** The list filters, shared by the page query and the totals query. */
export interface ExpenseFilters {
  /** Inclusive lower bound, `YYYY-MM-DD`. */
  from?: string | undefined;
  /** Inclusive upper bound, `YYYY-MM-DD`. */
  to?: string | undefined;
  categoryIds?: string[] | undefined;
  /** Case-insensitive substring of `description`. */
  q?: string | undefined;
}

export interface ListOptions extends ExpenseFilters {
  /** `null` on the first page; a decoded position on every page after it. */
  cursor?: Cursor | null;
  limit: number;
}

export interface ExpensePage {
  items: ExpenseRecord[];
  /** `null` when this is the last page. */
  nextCursor: string | null;
}

/**
 * One CSV line's worth of expense, with the category's *name* — the export is
 * read by a person in a spreadsheet, to whom a uuid says nothing. `id` rides
 * along because it is half the keyset cursor the batched walk pages on; it is
 * not written to the file.
 */
export interface ExportRow {
  id: string;
  date: string;
  categoryName: string;
  description: string;
  notes: string | null;
  amountMinor: number;
  currency: "LKR";
}

/**
 * Rows per round trip in `streamForExport`. Large enough that a normal account
 * exports in one or two queries, small enough that the whole table is never in
 * memory at once. Exported so the export test can seed past it and actually
 * exercise the second batch.
 */
export const EXPORT_BATCH_SIZE = 100;

export interface ExpenseTotals {
  totalCount: number;
  /**
   * `null` when the sum is past the largest integer a JSON number carries
   * exactly. The per-row CHECK caps a single `amount_minor` at 2^53 - 1, but
   * nothing caps a sum of legal rows — two at the ceiling already exceed it.
   * Rounding would be precisely the lossy money the integer-minor-units rule
   * exists to prevent, so the caller is told there is no exact answer instead.
   */
  totalAmountMinor: number | null;
}

/** `%`, `_` and `\` are LIKE syntax; a user searching for them means the characters. */
const LIKE_SPECIAL = /[\\%_]/g;

/**
 * design/api.md: `q` is an ILIKE substring match on `description`, capped at 100
 * characters, and the `%term%` scan is knowingly non-indexed — fine at per-user
 * v1 volumes, with a trigram index as the documented upgrade path.
 *
 * The escape is not optional: unescaped, a `q` of `%` becomes the pattern `%%%`
 * and matches every row, which is a filter that silently does the opposite of
 * what it says.
 */
const descriptionMatches = (q: string): SQL =>
  sql`${expenses.description} ilike ${`%${q.replace(LIKE_SPECIAL, (c) => `\\${c}`)}%`} escape '\\'`;

/**
 * The `user_id` predicate is first and unconditional — it is the ownership
 * boundary, not a filter, and building it here is what stops the page query and
 * the totals query from drifting apart about who owns what.
 */
function filterConditions(userId: string, f: ExpenseFilters): SQL[] {
  const where: SQL[] = [eq(expenses.userId, userId)];
  if (f.from !== undefined) where.push(gte(expenses.date, f.from));
  if (f.to !== undefined) where.push(lte(expenses.date, f.to));
  if (f.categoryIds !== undefined) {
    where.push(inArray(expenses.categoryId, f.categoryIds));
  }
  if (f.q !== undefined && f.q !== "") where.push(descriptionMatches(f.q));
  return where;
}

/**
 * Every method takes `userId` and puts it in the WHERE — including the reads.
 * An unscoped SELECT here looks correct for a user who owns rows and returns the
 * whole table for one who does not.
 */
export const expensesRepo = {
  async findById(
    db: Db,
    userId: string,
    id: string,
  ): Promise<ExpenseRecord | null> {
    const [row] = await db
      .select(expenseColumns)
      .from(expenses)
      .where(and(eq(expenses.userId, userId), eq(expenses.id, id)))
      .limit(1);
    return row ?? null;
  },

  /**
   * One page of the filtered list, newest first.
   *
   * The sort is `(date, id)` descending, which `expenses_user_date_idx` is built
   * to serve, and the cursor compares on the same tuple: `(date, id) < (d, i)`
   * as a single row comparison rather than `date < d OR (date = d AND id < i)`.
   * The two are equivalent, but the row form is the one Postgres can drive
   * straight off the index, and it cannot be got subtly wrong the way the
   * expanded boolean can.
   *
   * `id` is in the sort key because `date` is not unique — several expenses a
   * day is the normal case, and without a tiebreak their relative order is
   * whatever the plan happens to produce, which is enough to duplicate or drop
   * rows at a page boundary.
   */
  async list(db: Db, userId: string, opts: ListOptions): Promise<ExpensePage> {
    const where = filterConditions(userId, opts);
    if (opts.cursor) {
      // The casts are explicit because the comparison is what tells Postgres
      // these parameters are a date and a uuid rather than text.
      where.push(
        sql`(${expenses.date}, ${expenses.id}) < (${opts.cursor.date}::date, ${opts.cursor.id}::uuid)`,
      );
    }

    // One row past the page. Whether it exists is the entire "is there another
    // page?" question, and it costs one row instead of a second count query —
    // and unlike `totalCount > offset + limit` it stays correct when a row is
    // written between the two calls.
    const rows = await db
      .select(expenseColumns)
      .from(expenses)
      .where(and(...where))
      .orderBy(desc(expenses.date), desc(expenses.id))
      .limit(opts.limit + 1);

    const items = rows.slice(0, opts.limit);
    const last = items.at(-1);
    const nextCursor =
      rows.length > opts.limit && last !== undefined
        ? encodeCursor({ date: last.date, id: last.id })
        : null;

    return { items, nextCursor };
  },

  /**
   * `count(*)` and `sum(amount_minor)` over the same filters as `list`, in SQL.
   *
   * Summing the returned page in JS would be a different number: the page is at
   * most `limit` rows and the totals describe every matching row. Aggregating in
   * the database is also the only version that stays one round trip as the row
   * count grows.
   *
   * `sum` over `bigint` returns `numeric`, which Postgres can carry far past
   * what a JS number represents exactly. It is kept as text all the way here so
   * the range check happens *before* the conversion that would round it — read
   * as a number first and the evidence of the overflow is already gone.
   */
  async totals(
    db: Db,
    userId: string,
    f: ExpenseFilters,
  ): Promise<ExpenseTotals> {
    const [row] = await db
      .select({
        // `count(*)` is bounded by the number of rows, so it cannot overflow.
        totalCount: sql<number>`count(*)`.mapWith(Number),
        sumText: sql<string>`coalesce(sum(${expenses.amountMinor}), 0)::text`,
      })
      .from(expenses)
      .where(and(...filterConditions(userId, f)));

    // An aggregate with no GROUP BY always returns exactly one row; the fallback
    // is for `noUncheckedIndexedAccess`, not for a case that can happen.
    if (!row) return { totalCount: 0, totalAmountMinor: 0 };

    const total = Number(row.sumText);
    return {
      totalCount: row.totalCount,
      totalAmountMinor: Number.isSafeInteger(total) ? total : null,
    };
  },

  /**
   * Every matching row, newest first, in batches — the CSV export's source.
   *
   * An async generator rather than an array because the export has no
   * pagination: `select(...)` with no limit is one query whose result set is
   * however many expenses the user has ever filed, materialised in this
   * process before the first byte reaches them. Batching keeps the memory
   * bounded no matter how large the account gets, and the route writes each
   * batch out as it arrives.
   *
   * The paging is the same keyset walk `list` does — `(date, id)` descending,
   * driven off `expenses_user_date_idx` — and for the same reason: an OFFSET
   * walk over a table being written to duplicates and skips rows, and an export
   * that quietly drops one is worse than one that fails.
   *
   * The join is an inner join, which is not a filter here: `category_id` is NOT
   * NULL with an FK, and `ON DELETE RESTRICT` means the category cannot vanish
   * out from under an expense. It supplies the name for column 2.
   */
  async *streamForExport(
    db: Db,
    userId: string,
    f: ExpenseFilters,
  ): AsyncGenerator<ExportRow> {
    let cursor: Cursor | null = null;

    for (;;) {
      const where = filterConditions(userId, f);
      if (cursor) {
        where.push(
          sql`(${expenses.date}, ${expenses.id}) < (${cursor.date}::date, ${cursor.id}::uuid)`,
        );
      }

      const rows = await db
        .select({
          id: expenses.id,
          date: expenses.date,
          categoryName: categories.name,
          description: expenses.description,
          notes: expenses.notes,
          amountMinor: expenses.amountMinor,
          currency: expenses.currency,
        })
        .from(expenses)
        .innerJoin(categories, eq(categories.id, expenses.categoryId))
        .where(and(...where))
        .orderBy(desc(expenses.date), desc(expenses.id))
        .limit(EXPORT_BATCH_SIZE);

      for (const row of rows) yield row;

      // A short batch is the last batch. Asking for one more row to find out,
      // the way `list` does, would only tell us what a short read already has.
      if (rows.length < EXPORT_BATCH_SIZE) return;

      const last = rows.at(-1);
      if (last === undefined) return;
      cursor = { date: last.date, id: last.id };
    }
  },

  async create(
    db: Db,
    userId: string,
    input: CreateExpenseBody,
  ): Promise<ExpenseResult> {
    const check = await categoryUsable(db, userId, input.categoryId);
    if (check !== "ok") return { ok: false, reason: check };

    const [row] = await db
      .insert(expenses)
      .values({
        id: newId(),
        userId,
        categoryId: input.categoryId,
        amountMinor: input.amountMinor,
        date: input.date,
        description: input.description,
        notes: input.notes ?? null,
        // `currency` and `recurring_rule_id` are not taken from input: the first
        // is fixed at 'LKR' by the column default and its CHECK, the second is
        // set only by the recurring-rule generator.
      })
      .returning(expenseColumns);
    if (!row) throw new Error("expense insert returned no row");

    return { ok: true, expense: row };
  },

  async patch(
    db: Db,
    userId: string,
    id: string,
    changes: PatchExpenseBody,
  ): Promise<ExpenseResult> {
    // Ownership first, so "not your expense" is the answer even when the body
    // also names a category that is not the user's. Answering about the category
    // instead would describe a row the caller has no business knowing about.
    if ((await expensesRepo.findById(db, userId, id)) === null) {
      return { ok: false, reason: "not_found" };
    }

    if (changes.categoryId !== undefined) {
      const check = await categoryUsable(db, userId, changes.categoryId);
      if (check !== "ok") return { ok: false, reason: check };
    }

    const set: Partial<typeof expenses.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (changes.amountMinor !== undefined)
      set.amountMinor = changes.amountMinor;
    if (changes.categoryId !== undefined) set.categoryId = changes.categoryId;
    if (changes.date !== undefined) set.date = changes.date;
    if (changes.description !== undefined)
      set.description = changes.description;
    if (changes.notes !== undefined) set.notes = changes.notes;

    const [row] = await db
      .update(expenses)
      .set(set)
      .where(and(eq(expenses.userId, userId), eq(expenses.id, id)))
      .returning(expenseColumns);
    return row
      ? { ok: true, expense: row }
      : { ok: false, reason: "not_found" };
  },

  /** `true` when a row was actually removed; `false` is the route's 404. */
  async delete(db: Db, userId: string, id: string): Promise<boolean> {
    const rows = await db
      .delete(expenses)
      .where(and(eq(expenses.userId, userId), eq(expenses.id, id)))
      .returning({ id: expenses.id });
    return rows.length === 1;
  },
};
