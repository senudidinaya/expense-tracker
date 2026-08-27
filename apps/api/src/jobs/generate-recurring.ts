/**
 * The recurring generator: idempotent catch-up, one transaction per rule.
 *
 * `today` is always injected. Nothing here reads the clock — not
 * `new Date()`, not `todayUtc()` — because the cron that calls this
 * (Task 16) decides what day it is, and because every awkward calendar case
 * is otherwise untestable without freezing time.
 *
 * ## The two idempotency guards
 *
 * Both are required, and they fail in different situations (CLAUDE.md):
 *
 *  - `recurring_rules.next_occurrence` is a CURSOR. It is an application
 *    belief, read at the start of a rule's transaction and written at the
 *    end, so it is stale for the whole span in between. It stops a second
 *    run *on the same day* from finding the rule due at all.
 *  - `expenses_rule_date_uq` is the CONSTRAINT. Postgres checks it against
 *    committed state at write time, so it holds when two runs genuinely
 *    overlap — a retried cron, a `workflow_dispatch` firing alongside the
 *    schedule, a job restarted mid-flight. Naming it as the `ON CONFLICT`
 *    target also makes it a hard dependency of the write path: drop it and
 *    every insert fails at plan time (42P10), never silently duplicates.
 *
 * `ON CONFLICT DO NOTHING` is not a third guard — it only decides whether an
 * expected collision is a no-op or a loud failure.
 *
 * The cursor prevents repetition across runs; the index prevents duplication
 * within a race. Neither substitutes for the other.
 *
 * ## `rulesProcessed` and SKIP LOCKED
 *
 * A rule skipped by `SKIP LOCKED` does **not** count toward
 * `rulesProcessed`. Another run holds that row and will process it, count
 * it, and log it there; counting it in both runs would double-count the
 * number Task 16's nightly summary prints. `rulesProcessed` therefore means
 * "rules this run actually took responsibility for" — which includes rules
 * that were skipped for an archived category and rules that failed, since
 * this run is the one that has to report them.
 *
 * ## Untested behaviour
 *
 * `FOR UPDATE SKIP LOCKED` has no test. Proving it takes two transactions
 * racing on the same row, which needs a second connection held open at a
 * precise point mid-statement; from Vitest that is a sleep-and-hope test
 * that would flake in CI more often than it would catch a regression. The
 * per-rule locking is deliberately the one thing here verified by reading
 * rather than by running. The 400-occurrence cap is likewise untested — it
 * takes a rule ~8 years stale to reach.
 */

import { and, asc, eq, lte, sql } from "drizzle-orm";
import pino, { type Logger } from "pino";
import type { Db } from "../db/client.js";
import { categories, expenses, recurringRules } from "../db/schema.js";
import { nextOccurrence, occurrencesThrough } from "../domain/recurring.js";
import { newId } from "../lib/ids.js";
import { errorMessage } from "../lib/pg-errors.js";

/** Used when nobody passes one in — a direct `pnpm exec` of this module. */
const defaultLog = pino({ name: "generate-recurring" });

/**
 * A single run's ceiling per rule. A rule whose cursor is years stale — a
 * database restored from an old backup, a bug that parked `next_occurrence`
 * in 2019 — would otherwise turn one nightly run into an unbounded insert.
 * The cap bounds the blast radius without losing the backlog: the cursor
 * advances only past what was generated, so the next run resumes where this
 * one stopped.
 */
const MAX_OCCURRENCES_PER_RULE = 400;

export interface GenerateRecurringResult {
  /** Rules this run took responsibility for; excludes SKIP LOCKED misses. */
  rulesProcessed: number;
  /** Rows actually written — the count of RETURNING rows, not of occurrences. */
  inserted: number;
  /** Rules passed over because their category is archived. */
  skipped: number;
  /** `<rule id>: <message>` per rule that threw. Empty means a clean run. */
  failures: string[];
}

/** What one rule's transaction reports back to the loop. */
type RuleOutcome =
  | { status: "locked" }
  | { status: "skipped" }
  | { status: "generated"; inserted: number };

/**
 * The columns the generator needs, `user_id` included — unlike the repository
 * layer, this reads the table directly and has to stamp ownership onto every
 * row it writes.
 */
const ruleColumns = {
  id: recurringRules.id,
  userId: recurringRules.userId,
  categoryId: recurringRules.categoryId,
  amountMinor: recurringRules.amountMinor,
  currency: recurringRules.currency,
  description: recurringRules.description,
  notes: recurringRules.notes,
  frequency: recurringRules.frequency,
  startDate: recurringRules.startDate,
  endDate: recurringRules.endDate,
  nextOccurrence: recurringRules.nextOccurrence,
} as const;

/**
 * One locked rule, as the generator sees it. `startDate`/`endDate`/
 * `nextOccurrence` are `YYYY-MM-DD` strings — Drizzle `date()` columns come
 * back as strings, which is also exactly what the occurrence math takes.
 */
interface DueRule {
  id: string;
  userId: string;
  categoryId: string;
  amountMinor: number;
  currency: "LKR";
  description: string;
  notes: string | null;
  frequency: "weekly" | "monthly";
  startDate: string;
  endDate: string | null;
  nextOccurrence: string;
}

/**
 * Generates every occurrence due through `today`, for every rule in the
 * database. Runs from the nightly cron against the database directly; the
 * web service is not involved.
 */
export async function generateRecurring(
  db: Db,
  today: string,
  /**
   * The nightly job (Task 16) passes a child logger carrying its run id, so
   * the generator's per-rule lines correlate with the two steps that ran
   * before it. Defaulted rather than required: this stays runnable on its own.
   */
  log: Logger = defaultLog,
): Promise<GenerateRecurringResult> {
  // Read outside any transaction: this is only the work list. Every field it
  // carries is re-read under the lock before being acted on.
  const due = await db
    .select({ id: recurringRules.id })
    .from(recurringRules)
    .where(lte(recurringRules.nextOccurrence, today))
    .orderBy(asc(recurringRules.nextOccurrence), asc(recurringRules.id));

  const result: GenerateRecurringResult = {
    rulesProcessed: 0,
    inserted: 0,
    skipped: 0,
    failures: [],
  };

  for (const { id } of due) {
    try {
      // One transaction per rule, not one for the run: a rule that throws must
      // roll back its own occurrences and nothing else.
      const outcome = await db.transaction((tx) =>
        processRule(tx, id, today, log),
      );

      // Held by a concurrent run — not this run's to count or report.
      if (outcome.status === "locked") continue;

      result.rulesProcessed += 1;
      if (outcome.status === "skipped") result.skipped += 1;
      else result.inserted += outcome.inserted;
    } catch (err) {
      // One bad rule must not abort the run. The rule keeps its cursor (the
      // transaction rolled back), so the next run retries it.
      result.rulesProcessed += 1;
      result.failures.push(`${id}: ${errorMessage(err)}`);
      log.error(
        { ruleId: id, err: errorMessage(err) },
        "recurring rule failed",
      );
    }
  }

  return result;
}

/** A transaction handle — what `db.transaction` hands its callback. */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * One rule, inside its own transaction. Returns rather than throws for the
 * two expected non-generating outcomes; anything unexpected throws and the
 * caller records it.
 */
async function processRule(
  tx: Tx,
  ruleId: string,
  today: string,
  log: Logger,
): Promise<RuleOutcome> {
  // Re-read under a row lock. SKIP LOCKED rather than a plain FOR UPDATE:
  // a rule another run already holds is being generated right now, so waiting
  // for it would only buy the right to find nothing due.
  const [rule] = await tx
    .select(ruleColumns)
    .from(recurringRules)
    .where(eq(recurringRules.id, ruleId))
    .for("update", { skipLocked: true });

  // Either locked by a concurrent run, or deleted between the work list and
  // now. Both mean: not this run's rule.
  if (!rule) return { status: "locked" };

  const [category] = await tx
    .select({ archivedAt: categories.archivedAt })
    .from(categories)
    .where(
      and(
        eq(categories.id, rule.categoryId),
        // Scoped by owner like every other read. The FK plus the create route
        // already guarantee this matches; if it ever does not, the empty
        // result throws below rather than writing a cross-user row.
        eq(categories.userId, rule.userId),
      ),
    );
  if (!category) {
    throw new Error(`category ${rule.categoryId} missing for its rule's owner`);
  }

  if (category.archivedAt !== null) {
    // The API returns 400 on a manual create into an archived category, so a
    // background job must not be able to write the row a user cannot. The
    // cursor still advances: leaving it in place would hold a silent backlog
    // that dumps every missed occurrence at once if the category is later
    // unarchived, whereas advancing makes the skip permanent and visible.
    await advanceCursor(tx, rule.id, nextOccurrence(rule, today));
    log.info(
      { ruleId: rule.id, categoryId: rule.categoryId },
      "skipping recurring rule: category is archived",
    );
    return { status: "skipped" };
  }

  const all = occurrencesThrough(rule, rule.nextOccurrence, today);
  const occurrences = all.slice(0, MAX_OCCURRENCES_PER_RULE);
  const capped = occurrences.length < all.length;
  if (capped) {
    log.warn(
      { ruleId: rule.id, generated: occurrences.length, due: all.length },
      "recurring rule hit the per-run occurrence cap; resuming next run",
    );
  }

  const inserted =
    occurrences.length === 0
      ? 0
      : await insertOccurrences(tx, rule, occurrences);

  // Past `today` normally; only past the last generated date when the cap cut
  // the run short, so the remainder is picked up rather than skipped. Either
  // way `nextOccurrence` derives from the anchor day in `start_date` — never
  // by stepping from a clamped date. If the new cursor is beyond `end_date`
  // the rule simply never matches `next_occurrence <= today` again; no flag,
  // no separate "finished" state.
  const last = occurrences[occurrences.length - 1];
  await advanceCursor(
    tx,
    rule.id,
    nextOccurrence(rule, capped && last !== undefined ? last : today),
  );

  return { status: "generated", inserted };
}

/**
 * The occurrence rows, built by explicit field assignment. Deliberately not
 * `{ ...rule, ... }`: a spread would carry `rule.id` into the expense's
 * primary key and `rule.nextOccurrence` into a column that does not exist.
 * Each expense is a new row that happens to be described by the rule.
 */
async function insertOccurrences(
  tx: Tx,
  rule: DueRule,
  occurrences: string[],
): Promise<number> {
  const written = await tx
    .insert(expenses)
    .values(
      occurrences.map((date) => ({
        id: newId(),
        userId: rule.userId,
        categoryId: rule.categoryId,
        recurringRuleId: rule.id,
        amountMinor: rule.amountMinor,
        currency: rule.currency,
        date,
        description: rule.description,
        notes: rule.notes,
      })),
    )
    // Targeted at `expenses_rule_date_uq` specifically — a bare
    // `onConflictDoNothing()` would swallow every other constraint too, and a
    // primary-key collision should be a loud failure, not a silent no-op. The
    // index is partial, so its predicate has to be restated for Postgres to
    // infer it — that is what `where` is here (the index predicate, not a row
    // filter; drizzle renders it as `(cols) where <predicate> do nothing`).
    //
    // Naming the target also makes the index a hard dependency of this write
    // path, which is the safer failure: a migration that drops
    // `expenses_rule_date_uq` fails every insert loudly at plan time (42P10,
    // "no unique or exclusion constraint matching the ON CONFLICT
    // specification") instead of degrading into silent duplicates, which is
    // what a bare `onConflictDoNothing()` — happy with any arbiter — would do.
    .onConflictDoNothing({
      target: [expenses.recurringRuleId, expenses.date],
      where: sql`recurring_rule_id is not null`,
    })
    .returning({ id: expenses.id });

  // The count of rows Postgres actually wrote. Never `occurrences.length` —
  // the two differ by exactly the duplicates a concurrent run got to first,
  // which is the number worth reporting.
  return written.length;
}

/**
 * `updated_at` is deliberately left alone: it is the rule's last *edit*, and
 * a cursor advance is bookkeeping, not a user changing their mind.
 */
const advanceCursor = async (tx: Tx, ruleId: string, to: string) => {
  await tx
    .update(recurringRules)
    .set({ nextOccurrence: to })
    .where(eq(recurringRules.id, ruleId));
};
