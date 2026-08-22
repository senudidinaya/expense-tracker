import type { CreateExpenseBody, PatchExpenseBody } from "@expense/shared";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { categories, expenses } from "../db/schema.js";
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
   * Task 9 adds the filters, the keyset cursor and the first-page totals. The
   * ordering is already the one the cursor will compare on — `(date, id)`
   * descending, matching `expenses_user_date_idx` — so pagination slots into
   * this query rather than replacing it.
   */
  async list(db: Db, userId: string): Promise<ExpenseRecord[]> {
    return db
      .select(expenseColumns)
      .from(expenses)
      .where(eq(expenses.userId, userId))
      .orderBy(desc(expenses.date), desc(expenses.id));
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
