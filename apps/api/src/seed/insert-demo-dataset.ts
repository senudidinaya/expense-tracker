/**
 * Writing a `DemoDataset` (seed/demo-data.ts) into a user's tables.
 *
 * Separate from both callers because there are two: demo provisioning
 * (`usersRepo.provisionDemo`) and the local seed script
 * (`jobs/seed-local.ts`). What they disagree about is the user — one is an
 * ephemeral `is_demo` visitor inside a transaction that also mints a session,
 * the other is a named dev account — and they agree about everything after it.
 * A second copy of these three inserts is a second place for the column list,
 * the `newId()` per row and the "no `recurring_rule_id` on seeded history" rule
 * to drift.
 *
 * Takes `DbOrTx` so the caller decides the transaction: provisioning needs
 * these rows in the same one as the user.
 */

import type { DbOrTx } from "../db/client.js";
import { budgets, expenses, recurringRules } from "../db/schema.js";
import { newId } from "../lib/ids.js";
import { demoDataset } from "./demo-data.js";

export interface InsertDemoDatasetOptions {
  userId: string;
  /** `YYYY-MM-DD`, from the caller's clock — see seed/demo-data.ts. */
  today: string;
  /** The PRNG seed; determines the amounts, not the shape. */
  seed: string;
  /** Category name -> id, for the categories this user already has. */
  categoryIds: ReadonlyMap<string, string>;
}

export async function insertDemoDataset(
  tx: DbOrTx,
  { userId, today, seed, categoryIds }: InsertDemoDatasetOptions,
): Promise<void> {
  const categoryId = (name: string): string => {
    const found = categoryIds.get(name);
    // Unreachable while the dataset draws from the default seed set, which its
    // own unit test enforces. Loud here rather than a null constraint
    // violation three statements later.
    if (found === undefined) {
      throw new Error(`demo dataset names an unknown category: ${name}`);
    }
    return found;
  };

  const dataset = demoDataset(today, seed);

  await tx.insert(recurringRules).values(
    dataset.recurringRules.map((rule) => ({
      id: newId(),
      userId,
      categoryId: categoryId(rule.category),
      amountMinor: rule.amountMinor,
      description: rule.description,
      notes: null,
      frequency: rule.frequency,
      startDate: rule.startDate,
      endDate: rule.endDate,
      nextOccurrence: rule.nextOccurrence,
    })),
  );

  // No `recurring_rule_id` on these rows, deliberately: they are the user's
  // history, not the generator's output. See seed/demo-data.ts.
  await tx.insert(expenses).values(
    dataset.expenses.map((expense) => ({
      id: newId(),
      userId,
      categoryId: categoryId(expense.category),
      amountMinor: expense.amountMinor,
      date: expense.date,
      description: expense.description,
      notes: expense.notes,
    })),
  );

  await tx.insert(budgets).values(
    dataset.budgets.map((budget) => ({
      id: newId(),
      userId,
      categoryId: categoryId(budget.category),
      monthStart: budget.monthStart,
      amountMinor: budget.amountMinor,
    })),
  );
}
