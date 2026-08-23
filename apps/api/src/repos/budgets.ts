import { and, eq, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { budgets, categories } from "../db/schema.js";
import {
  monthStartOf,
  resolveEffective,
  type EffectiveBudget,
} from "../domain/budgets.js";
import { newId } from "../lib/ids.js";
import { categoriesRepo, type CategoryCheck } from "./categories.js";

/** Everything a caller outside this file may know about a budget row. */
export interface BudgetRecord {
  id: string;
  categoryId: string;
  /** `YYYY-MM-DD`, always the 1st — the DATE column verbatim. */
  monthStart: string;
  /** Integer minor units, or `null` for "cleared from this month forward". */
  amountMinor: number | null;
  /** Fixed by `CHECK (currency = 'LKR')`; see `$type` on the column. */
  currency: "LKR";
  createdAt: Date;
  updatedAt: Date;
}

/** Selected explicitly so `user_id` never rides along into a response. */
const budgetColumns = {
  id: budgets.id,
  categoryId: budgets.categoryId,
  monthStart: budgets.monthStart,
  amountMinor: budgets.amountMinor,
  currency: budgets.currency,
  createdAt: budgets.createdAt,
  updatedAt: budgets.updatedAt,
} as const;

/** One category's effective budget for the requested month. */
export interface EffectiveBudgetRecord extends EffectiveBudget {
  categoryId: string;
}

export type BudgetPutResult =
  | { ok: true; budget: BudgetRecord }
  | { ok: false; reason: Exclude<CategoryCheck, "ok"> };

/**
 * Every method takes `userId` and puts it in the WHERE — the whole of ownership
 * enforcement, with `user_id` denormalized onto the table so no join is needed
 * to do it. `category_id` is checked separately, because a budget can name a
 * category the caller does not own.
 */
export const budgetsRepo = {
  /**
   * The effective budget for each of the user's **active** categories in
   * `month` (`YYYY-MM`), in one query.
   *
   * `DISTINCT ON (category_id) ... WHERE month_start <= $month ORDER BY
   * category_id, month_start DESC` is the whole resolution: Postgres keeps the
   * first row per category, which the ORDER BY makes the greatest
   * `month_start` at or before the month. It reads only the rows that could
   * win rather than a category's whole history, and it stays one round trip
   * however many months of history an account accumulates.
   *
   * The rows it returns still go through `resolveEffective` rather than being
   * shaped here. That function is the definition of what a set of rows means
   * for a month — including the part SQL cannot express, that a NULL amount is
   * a *recorded* clear and an absent row is not — so running it over the
   * narrowed set keeps the SQL and Task 12's report from drifting into two
   * slightly different answers. It does not assume the ordering it was handed.
   *
   * Categories with no row at or before `month` are absent from the result, not
   * present with a null: there is no `effectiveFrom` to report for a budget
   * nobody ever set, and `effectiveBudgetDto` says so by making the field
   * non-nullable.
   */
  async effectiveForMonth(
    db: Db,
    userId: string,
    month: string,
  ): Promise<EffectiveBudgetRecord[]> {
    const rows = await db
      .selectDistinctOn([budgets.categoryId], {
        categoryId: budgets.categoryId,
        monthStart: budgets.monthStart,
        amountMinor: budgets.amountMinor,
      })
      .from(budgets)
      // Inner join, and it is a filter: an archived category drops out of the
      // budgeting surface even though its past expenses stay in reports.
      .innerJoin(categories, eq(categories.id, budgets.categoryId))
      .where(
        and(
          eq(budgets.userId, userId),
          isNull(categories.archivedAt),
          lte(budgets.monthStart, monthStartOf(month)),
        ),
      )
      .orderBy(budgets.categoryId, sql`${budgets.monthStart} desc`);

    return rows.flatMap((row) => {
      // One candidate row per category by construction; `resolveEffective`
      // takes a list because that is what it means, not because this passes one.
      const effective = resolveEffective([row], month);
      return effective === null
        ? []
        : [{ categoryId: row.categoryId, ...effective }];
    });
  },

  /**
   * Sets or clears the budget for one category at one month.
   *
   * An upsert on the unique triple, not a read-then-write: PUT is idempotent
   * and two concurrent ones must not race into a unique violation or a second
   * row — a category with two rows for the same month has no defined effective
   * budget. `ON CONFLICT ... DO UPDATE` makes Postgres settle it.
   *
   * The category check is a separate query and runs first, so a category that
   * is not the caller's is refused before anything is written.
   */
  async put(
    db: Db,
    userId: string,
    categoryId: string,
    month: string,
    amountMinor: number | null,
  ): Promise<BudgetPutResult> {
    const check = await categoriesRepo.checkUsable(db, userId, categoryId);
    if (check !== "ok") return { ok: false, reason: check };

    const [row] = await db
      .insert(budgets)
      .values({
        id: newId(),
        userId,
        categoryId,
        monthStart: monthStartOf(month),
        amountMinor,
      })
      .onConflictDoUpdate({
        target: [budgets.userId, budgets.categoryId, budgets.monthStart],
        set: { amountMinor, updatedAt: new Date() },
      })
      .returning(budgetColumns);

    // An upsert with RETURNING always yields one row; this is for the type,
    // not for a case that can occur.
    if (!row) throw new Error("budget upsert returned no row");
    return { ok: true, budget: row };
  },
};
