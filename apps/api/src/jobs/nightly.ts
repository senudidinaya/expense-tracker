/**
 * The nightly job — reap demo users, sweep expired sessions, generate
 * recurring expenses — and the CLI wrapper GitHub Actions runs.
 *
 * The three steps and their order are fixed by design/delivery.md, and so is
 * the failure contract:
 *
 *   Each step runs independently — a failure in one does not prevent the
 *   others from running — but any step failure makes the script exit
 *   non-zero, so the Actions run is marked failed and surfaces in
 *   notifications. Logging alone is not a failure signal.
 *
 * That is why every step below has its own try/catch and why nothing rethrows:
 * a run in which the sweep fails must still reap and still generate, because
 * the three touch disjoint rows and there is no state one leaves that another
 * depends on. The single place the failures matter is the exit code.
 *
 * ## Two clocks, on purpose
 *
 * Steps 1 and 2 take their cutoffs from the injected `now`, which is what
 * makes "a demo user 25 hours old" testable without waiting a day. Step 3
 * passes `todayUtc()` — the codebase's one clock reader — because that is what
 * the demo seeder (Task 15) used when it wrote its rules' `next_occurrence`.
 * If the cron reasoned from a different calendar than the seeder, the first
 * night after a demo was provisioned could generate an occurrence the seeder
 * had already written as history. One definition of today, in `lib/dates.ts`,
 * for both.
 *
 * ## The run id
 *
 * One `newId()` per run, attached to a child logger, so all three steps — the
 * generator's per-rule lines included, which is why the logger is threaded
 * into `generateRecurring` — appear under one key in CI output. A night's work
 * is otherwise three unrelated bursts of JSON interleaved with whatever else
 * the runner printed.
 */

import { and, eq, lt } from "drizzle-orm";
import pino, { type Logger } from "pino";
import { pathToFileURL } from "node:url";
import { createDb, type Db } from "../db/client.js";
import { sessions, users } from "../db/schema.js";
import { envSchema } from "../env.js";
import { todayUtc } from "../lib/dates.js";
import { newId } from "../lib/ids.js";
import { errorMessage } from "../lib/pg-errors.js";
import { generateRecurring } from "./generate-recurring.js";

const defaultLog = pino({ name: "nightly" });

/**
 * design/api.md: demo users are reaped once they are more than 24h old. The
 * cap of 100 live demo users is what bounds the fleet at any moment; this is
 * what makes the bound temporary rather than permanent.
 */
export const DEMO_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface NightlyResult {
  /** On the result as well as in the logs, so a caller can quote it. */
  runId: string;
  /** Demo users deleted; their data and sessions went with them by cascade. */
  reaped: number;
  sweptSessions: number;
  /** The three counts `generateRecurring` reports, passed through unchanged. */
  rulesProcessed: number;
  inserted: number;
  skipped: number;
  /**
   * `<step>: <message>` per step that threw, plus one entry per rule the
   * generator could not process. Non-empty is what the CLI turns into a
   * non-zero exit; nothing else in the result is a failure signal.
   */
  failures: string[];
}

/**
 * Reap → sweep → generate, in that order, with each step isolated from the
 * ones around it. Never throws: a step that fails is reported in `failures`,
 * because the caller's job is to decide the exit code once, at the end, rather
 * than to lose the two steps that would have worked.
 */
export async function runNightly(
  db: Db,
  now: Date,
  opts: { logger?: Logger } = {},
): Promise<NightlyResult> {
  const runId = newId();
  const log = (opts.logger ?? defaultLog).child({ runId });

  const result: NightlyResult = {
    runId,
    reaped: 0,
    sweptSessions: 0,
    rulesProcessed: 0,
    inserted: 0,
    skipped: 0,
    failures: [],
  };

  /** One step's failure, recorded rather than raised. */
  const failed = (step: string, err: unknown): void => {
    const reason = errorMessage(err);
    result.failures.push(`${step}: ${reason}`);
    log.error({ step, err: reason }, "nightly step failed");
  };

  // -- 1. Reap demo users ----------------------------------------------------

  try {
    const cutoff = new Date(now.getTime() - DEMO_MAX_AGE_MS);
    // Only `users` is touched: every table that references a user does so with
    // ON DELETE CASCADE, so their categories, expenses, budgets, rules and
    // sessions go in the same statement. Deleting them by hand first would be
    // both redundant and a second place to keep the table list correct.
    const gone = await db
      .delete(users)
      .where(and(eq(users.isDemo, true), lt(users.createdAt, cutoff)))
      .returning({ id: users.id });
    result.reaped = gone.length;
    log.info(
      { step: "reap", reaped: gone.length, cutoff: cutoff.toISOString() },
      "reaped expired demo users",
    );
  } catch (err) {
    failed("reap", err);
  }

  // -- 2. Sweep expired sessions --------------------------------------------

  try {
    // The only thing that ever deletes an expired session. Logout deletes the
    // one row it holds a token for, and the auth plugin merely refuses an
    // expired row — without this step the table grows forever.
    const swept = await db
      .delete(sessions)
      .where(lt(sessions.expiresAt, now))
      .returning({ id: sessions.id });
    result.sweptSessions = swept.length;
    log.info(
      { step: "sweep", sweptSessions: swept.length },
      "swept expired sessions",
    );
  } catch (err) {
    failed("sweep", err);
  }

  // -- 3. Generate recurring expenses ---------------------------------------

  try {
    const generated = await generateRecurring(db, todayUtc(), log);
    result.rulesProcessed = generated.rulesProcessed;
    result.inserted = generated.inserted;
    result.skipped = generated.skipped;
    // Passed through, not swallowed: a rule that failed is exactly as much a
    // reason for a red run as a whole step that failed, and the rule id is the
    // only thing that makes it actionable. `generated.failures` entries are
    // already `<rule id>: <message>`.
    result.failures.push(
      ...generated.failures.map((f) => `generate rule ${f}`),
    );
    log.info(
      {
        step: "generate",
        rulesProcessed: generated.rulesProcessed,
        inserted: generated.inserted,
        skipped: generated.skipped,
        failed: generated.failures.length,
      },
      "generated recurring expenses",
    );
  } catch (err) {
    failed("generate", err);
  }

  return result;
}

// ---------------------------------------------------------------------------
// CLI — `tsx src/jobs/nightly.ts`, from .github/workflows/nightly.yml
// ---------------------------------------------------------------------------

/**
 * `DATABASE_URL` and nothing else.
 *
 * Deliberately not `loadEnv()`: that validates the whole web-service
 * environment — `SESSION_SECRET`, `APP_ORIGIN` — none of which this job has or
 * needs, and requiring them would mean putting a cookie signing key into a
 * workflow that never serves a request. The one variable it does read is
 * validated by the same schema field the app uses, so "what counts as a valid
 * DATABASE_URL" still has one definition.
 */
function databaseUrl(): string {
  const parsed = envSchema.shape.DATABASE_URL.safeParse(
    process.env.DATABASE_URL,
  );
  if (!parsed.success) {
    // No value in the message: an invalid URL is usually invalid because of
    // the password in it.
    throw new Error("DATABASE_URL is missing or is not a valid URL");
  }
  return parsed.data;
}

async function main(): Promise<void> {
  const { db, sql } = createDb(databaseUrl());
  let result: NightlyResult;
  try {
    result = await runNightly(db, new Date());
  } finally {
    await sql.end();
  }

  defaultLog.info(result, "nightly run finished");

  // The failure signal design/delivery.md asks for. Explicit rather than
  // falling off the end of `main`: the exit code is the contract, and pino's
  // default destination writes synchronously to fd 1, so nothing above is lost
  // to the exit.
  process.exit(result.failures.length > 0 ? 1 : 0);
}

/**
 * Only when run as a script. The nightly test imports `runNightly` from this
 * module, and an unguarded `main()` would try to open a database connection at
 * import time.
 */
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  await main();
}
