import type { CreateRecurringBody, PatchRecurringBody } from "@expense/shared";
import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { recurringRules } from "../db/schema.js";
import { firstOccurrenceOnOrAfter } from "../domain/recurring.js";
import { newId } from "../lib/ids.js";
import { categoriesRepo } from "./categories.js";

/** Everything a caller outside this file may know about a recurring rule. */
export interface RecurringRecord {
  id: string;
  categoryId: string;
  /** Integer minor units. Never a float, never a decimal string. */
  amountMinor: number;
  /** Fixed by `CHECK (currency = 'LKR')`; see `$type` on the column. */
  currency: "LKR";
  description: string;
  notes: string | null;
  frequency: "weekly" | "monthly";
  /** `YYYY-MM-DD` — Drizzle `date()` columns come back as strings, not `Date`. */
  startDate: string;
  endDate: string | null;
  nextOccurrence: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Selected explicitly so `user_id` never rides along into a response. */
const ruleColumns = {
  id: recurringRules.id,
  categoryId: recurringRules.categoryId,
  amountMinor: recurringRules.amountMinor,
  currency: recurringRules.currency,
  description: recurringRules.description,
  notes: recurringRules.notes,
  frequency: recurringRules.frequency,
  startDate: recurringRules.startDate,
  endDate: recurringRules.endDate,
  nextOccurrence: recurringRules.nextOccurrence,
  createdAt: recurringRules.createdAt,
  updatedAt: recurringRules.updatedAt,
} as const;

export type RecurringFailure =
  | "not_found"
  | "category_not_found"
  | "category_archived"
  /**
   * A patch carrying one bound that lands on the wrong side of the stored
   * other bound. The shared schema's refinement can only compare the bounds it
   * can see, so with one in the body the merged pair is checked here — the
   * alternative is the DB CHECK rejecting it as a 500.
   */
  | "end_before_start";

export type RecurringResult =
  { ok: true; rule: RecurringRecord } | { ok: false; reason: RecurringFailure };

/**
 * Every method takes `userId` and puts it in the WHERE — including the reads.
 * An unscoped SELECT here looks correct for a user who owns rows and returns
 * the whole table for one who does not.
 *
 * `today` is a parameter, not a clock read: the route hands in `todayUtc()`,
 * the generator (Task 14) hands in its own date, and the repo stays a pure
 * function of its arguments.
 */
export const recurringRepo = {
  async findById(
    db: Db,
    userId: string,
    id: string,
  ): Promise<RecurringRecord | null> {
    const [row] = await db
      .select(ruleColumns)
      .from(recurringRules)
      .where(and(eq(recurringRules.userId, userId), eq(recurringRules.id, id)))
      .limit(1);
    return row ?? null;
  },

  /** All of the user's rules, soonest due first, id as the tiebreak. */
  async list(db: Db, userId: string): Promise<RecurringRecord[]> {
    return db
      .select(ruleColumns)
      .from(recurringRules)
      .where(eq(recurringRules.userId, userId))
      .orderBy(asc(recurringRules.nextOccurrence), asc(recurringRules.id));
  },

  async create(
    db: Db,
    userId: string,
    input: CreateRecurringBody,
    today: string,
  ): Promise<RecurringResult> {
    const check = await categoriesRepo.checkUsable(
      db,
      userId,
      input.categoryId,
    );
    if (check !== "ok") return { ok: false, reason: check };

    const [row] = await db
      .insert(recurringRules)
      .values({
        id: newId(),
        userId,
        categoryId: input.categoryId,
        amountMinor: input.amountMinor,
        description: input.description,
        notes: input.notes ?? null,
        frequency: input.frequency,
        startDate: input.startDate,
        endDate: input.endDate ?? null,
        // design/api.md "no backfill": the cursor starts at the first
        // occurrence on or after today, never in the past — a rule anchored
        // last year does not owe a year of expenses on creation.
        nextOccurrence: firstOccurrenceOnOrAfter(input, today),
      })
      .returning(ruleColumns);
    if (!row) throw new Error("recurring rule insert returned no row");

    return { ok: true, rule: row };
  },

  async patch(
    db: Db,
    userId: string,
    id: string,
    changes: PatchRecurringBody,
    today: string,
  ): Promise<RecurringResult> {
    // Ownership first, so "not your rule" is the answer even when the body
    // also names a category that is not the user's.
    const existing = await recurringRepo.findById(db, userId, id);
    if (existing === null) return { ok: false, reason: "not_found" };

    if (changes.categoryId !== undefined) {
      const check = await categoriesRepo.checkUsable(
        db,
        userId,
        changes.categoryId,
      );
      if (check !== "ok") return { ok: false, reason: check };
    }

    // The bounds as they will be after the patch. The wire refinement compared
    // them only when both were in the body; the merged pair is what the CHECK
    // constraint will actually see.
    const startDate = changes.startDate ?? existing.startDate;
    const endDate = changes.endDate ?? existing.endDate;
    if (endDate !== null && endDate < startDate) {
      return { ok: false, reason: "end_before_start" };
    }

    const set: Partial<typeof recurringRules.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (changes.categoryId !== undefined) set.categoryId = changes.categoryId;
    if (changes.amountMinor !== undefined)
      set.amountMinor = changes.amountMinor;
    if (changes.description !== undefined)
      set.description = changes.description;
    if (changes.notes !== undefined) set.notes = changes.notes;
    if (changes.frequency !== undefined) set.frequency = changes.frequency;
    if (changes.startDate !== undefined) set.startDate = changes.startDate;
    if (changes.endDate !== undefined) set.endDate = changes.endDate;

    // Amendment B: recompute the cursor ONLY when the schedule itself changed.
    // A cursor in the past means the generator has catch-up pending, and an
    // edit to, say, the description must not move it — that would silently
    // drop the missed occurrences. A frequency/startDate change redefines the
    // schedule, so there the cursor re-derives (never in the past).
    if (changes.frequency !== undefined || changes.startDate !== undefined) {
      set.nextOccurrence = firstOccurrenceOnOrAfter(
        { frequency: changes.frequency ?? existing.frequency, startDate },
        today,
      );
    }

    const [row] = await db
      .update(recurringRules)
      .set(set)
      .where(and(eq(recurringRules.userId, userId), eq(recurringRules.id, id)))
      .returning(ruleColumns);
    return row ? { ok: true, rule: row } : { ok: false, reason: "not_found" };
  },

  /**
   * `true` when a row was actually removed; `false` is the route's 404.
   * Generated expenses survive: `expenses.recurring_rule_id` is FK
   * ON DELETE SET NULL — deleting a rule detaches its history, never erases it.
   */
  async delete(db: Db, userId: string, id: string): Promise<boolean> {
    const rows = await db
      .delete(recurringRules)
      .where(and(eq(recurringRules.userId, userId), eq(recurringRules.id, id)))
      .returning({ id: recurringRules.id });
    return rows.length === 1;
  },
};
