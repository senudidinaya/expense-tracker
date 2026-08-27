import type { PgTable } from "drizzle-orm/pg-core";
import { eq, sql } from "drizzle-orm";
import pino from "pino";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  budgets,
  categories,
  expenses,
  recurringRules,
  sessions,
  users,
} from "../../src/db/schema.js";
import { todayUtc } from "../../src/lib/dates.js";
import { newId } from "../../src/lib/ids.js";
import { runNightly } from "../../src/jobs/nightly.js";
import { makeTestApp } from "../helpers.js";

/**
 * Task 16, Step 1 — the nightly job: reap → sweep → generate.
 *
 * design/delivery.md fixes both the order and the failure semantics: the three
 * steps run **independently** — a failure in one does not stop the others —
 * and any failure makes the CLI exit non-zero so the Actions run is marked
 * failed. Logging alone is not a failure signal, so the thing worth testing is
 * not "did it log", it is "did the next step still run and did the result say
 * so".
 *
 * ## `now` is injected, `today` is not
 *
 * Steps 1 and 2 take their cutoffs from the `now` parameter, which is what
 * lets a test place a demo user 25 hours in the past without waiting a day.
 * Step 3 passes `todayUtc()` — deliberately, and decided rather than derived:
 * the demo seeder (Task 15) writes its rules' cursors from `todayUtc()` too,
 * and a cron that disagreed with the seeder about which day it is would
 * generate an occurrence the seeder already wrote as history. One definition
 * of today, in `lib/dates.ts`, for both.
 *
 * Consequence here: the recurring fixtures are anchored to `todayUtc()` and
 * not to the `now` the tests inject.
 *
 * ## The run id
 *
 * Every line the job logs carries a `runId`, so one night's three steps can be
 * picked out of CI output together — including the generator's own per-rule
 * lines, which is why the logger is threaded into `generateRecurring` rather
 * than left as its module-level default. The failure test asserts that
 * property directly by handing `runNightly` a logger that writes into an
 * array.
 */

let app: Awaited<ReturnType<typeof makeTestApp>>["app"];
let db: Awaited<ReturnType<typeof makeTestApp>>["db"];
let stop: (() => Promise<void>) | undefined;

const HOUR_MS = 60 * 60 * 1000;

/** A fixed instant, so "25 hours ago" means the same thing in every test. */
const NOW = new Date("2026-06-15T20:30:00.000Z");

const hoursBefore = (h: number): Date => new Date(NOW.getTime() - h * HOUR_MS);

beforeAll(async () => {
  const started = await makeTestApp();
  app = started.app;
  db = started.db;
  stop = started.stop;
  await app.ready();
});

afterAll(async () => {
  await stop?.();
});

// One delete: every other table hangs off `users` by a cascading FK, which is
// the same property the reap step depends on.
beforeEach(async () => {
  await db.delete(users);
});

// ---------------------------------------------------------------------------
// Fixtures — written straight to the tables
// ---------------------------------------------------------------------------

/**
 * Rows go in directly rather than through the API because every field that
 * matters here is one no route will set: `created_at` in the past (the reap
 * cutoff), `expires_at` in the past (the sweep), and a `next_occurrence`
 * cursor that is already due (the generator).
 */
let labels = 0;

async function insertUser(opts: {
  isDemo?: boolean;
  createdAt: Date;
}): Promise<string> {
  const id = newId();
  labels += 1;
  await db.insert(users).values({
    id,
    email: `nightly-${labels}@example.com`,
    // Never verified against — nothing in this suite logs in.
    passwordHash: "not-a-real-argon2-hash",
    isDemo: opts.isDemo ?? false,
    createdAt: opts.createdAt,
  });
  return id;
}

async function insertCategory(userId: string): Promise<string> {
  const id = newId();
  await db.insert(categories).values({ id, userId, name: "Food" });
  return id;
}

async function insertExpense(
  userId: string,
  categoryId: string,
): Promise<string> {
  const id = newId();
  await db.insert(expenses).values({
    id,
    userId,
    categoryId,
    amountMinor: 1_250_00,
    date: "2026-06-01",
    description: "Lunch",
  });
  return id;
}

async function insertBudget(
  userId: string,
  categoryId: string,
): Promise<string> {
  const id = newId();
  await db.insert(budgets).values({
    id,
    userId,
    categoryId,
    monthStart: "2026-06-01",
    amountMinor: 50_000_00,
  });
  return id;
}

async function insertRule(
  userId: string,
  categoryId: string,
  dates: { startDate: string; nextOccurrence: string },
): Promise<string> {
  const id = newId();
  await db.insert(recurringRules).values({
    id,
    userId,
    categoryId,
    amountMinor: 85_000_00,
    description: "Apartment rent",
    frequency: "monthly",
    startDate: dates.startDate,
    endDate: null,
    nextOccurrence: dates.nextOccurrence,
  });
  return id;
}

async function insertSession(userId: string, expiresAt: Date): Promise<string> {
  const id = newId();
  await db.insert(sessions).values({
    id,
    userId,
    tokenHash: `hash-${id}`,
    expiresAt,
  });
  return id;
}

/** A cursor far enough out that the generator never finds these rules due. */
const NOT_DUE = { startDate: "2099-01-01", nextOccurrence: "2099-01-01" };

/** One row in every table that hangs off a user, so a reap has work to prove. */
async function insertFullUser(opts: {
  isDemo?: boolean;
  createdAt: Date;
}): Promise<string> {
  const userId = await insertUser(opts);
  const categoryId = await insertCategory(userId);
  await insertExpense(userId, categoryId);
  await insertBudget(userId, categoryId);
  await insertRule(userId, categoryId, NOT_DUE);
  await insertSession(userId, new Date(NOW.getTime() + HOUR_MS));
  return userId;
}

/**
 * Everything this user still owns, per table. Written out one table at a time
 * rather than through a generic helper: the column each table is scoped by is
 * the interesting part of the assertion, and a helper would hide it behind a
 * cast.
 */
async function rowCounts(userId: string) {
  const rows = {
    users: await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, userId)),
    categories: await db
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.userId, userId)),
    expenses: await db
      .select({ id: expenses.id })
      .from(expenses)
      .where(eq(expenses.userId, userId)),
    budgets: await db
      .select({ id: budgets.id })
      .from(budgets)
      .where(eq(budgets.userId, userId)),
    recurringRules: await db
      .select({ id: recurringRules.id })
      .from(recurringRules)
      .where(eq(recurringRules.userId, userId)),
    sessions: await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.userId, userId)),
  };
  return {
    users: rows.users.length,
    categories: rows.categories.length,
    expenses: rows.expenses.length,
    budgets: rows.budgets.length,
    recurringRules: rows.recurringRules.length,
    sessions: rows.sessions.length,
  };
}

const NOTHING = {
  users: 0,
  categories: 0,
  expenses: 0,
  budgets: 0,
  recurringRules: 0,
  sessions: 0,
};

const EVERYTHING = {
  users: 1,
  categories: 1,
  expenses: 1,
  budgets: 1,
  recurringRules: 1,
  sessions: 1,
};

// ---------------------------------------------------------------------------

describe("runNightly", () => {
  describe("step 1 — reaping demo users", () => {
    it("deletes a demo user older than 24h with everything it owns, and leaves a fresh one alone", async () => {
      const old = await insertFullUser({
        isDemo: true,
        createdAt: hoursBefore(25),
      });
      const fresh = await insertFullUser({
        isDemo: true,
        createdAt: hoursBefore(1),
      });

      const result = await runNightly(db, NOW);

      expect(result.reaped).toBe(1);
      // The whole point of the cascade: no orphan expenses, budgets, rules or
      // sessions are left behind pointing at a user that no longer exists.
      expect(await rowCounts(old)).toEqual(NOTHING);
      expect(await rowCounts(fresh)).toEqual(EVERYTHING);
    });

    it("never reaps a non-demo user, however old", async () => {
      const ancient = await insertFullUser({
        isDemo: false,
        createdAt: new Date("2016-01-01T00:00:00.000Z"),
      });

      const result = await runNightly(db, NOW);

      expect(result.reaped).toBe(0);
      expect(await rowCounts(ancient)).toEqual(EVERYTHING);
    });
  });

  describe("step 2 — sweeping expired sessions", () => {
    it("deletes expired sessions and keeps valid ones", async () => {
      const userId = await insertUser({ createdAt: hoursBefore(1) });
      const expired = await insertSession(userId, hoursBefore(1));
      const valid = await insertSession(
        userId,
        new Date(NOW.getTime() + HOUR_MS),
      );

      const result = await runNightly(db, NOW);

      expect(result.sweptSessions).toBe(1);
      const left = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.userId, userId));
      expect(left.map((s) => s.id)).toEqual([valid]);
      expect(left.map((s) => s.id)).not.toContain(expired);
    });
  });

  describe("step 3 — recurring generation", () => {
    it("generates the occurrence a due rule owes", async () => {
      const today = todayUtc();
      const userId = await insertUser({ createdAt: hoursBefore(1) });
      const categoryId = await insertCategory(userId);
      const ruleId = await insertRule(userId, categoryId, {
        startDate: today,
        nextOccurrence: today,
      });

      const result = await runNightly(db, NOW);

      expect(result.rulesProcessed).toBe(1);
      expect(result.inserted).toBe(1);
      expect(result.skipped).toBe(0);
      // Pins the empty case only: it stays green whether or not `runNightly`
      // appends what the generator reports, because on a clean run there is
      // nothing to append. The test below is what guards the append.
      expect(result.failures).toEqual([]);

      const generated = await db
        .select({ date: expenses.date, amountMinor: expenses.amountMinor })
        .from(expenses)
        .where(eq(expenses.recurringRuleId, ruleId));
      expect(generated).toEqual([{ date: today, amountMinor: 85_000_00 }]);
    });

    it("surfaces the generator's `skipped` count rather than swallowing it", async () => {
      const today = todayUtc();
      const userId = await insertUser({ createdAt: hoursBefore(1) });
      const categoryId = await insertCategory(userId);
      await db
        .update(categories)
        .set({ archivedAt: NOW })
        .where(eq(categories.id, categoryId));
      await insertRule(userId, categoryId, {
        startDate: today,
        nextOccurrence: today,
      });

      const result = await runNightly(db, NOW);

      expect(result.rulesProcessed).toBe(1);
      expect(result.skipped).toBe(1);
      expect(result.inserted).toBe(0);
    });

    it("surfaces the generator's per-rule failures rather than swallowing them", async () => {
      const today = todayUtc();
      const userId = await insertUser({ createdAt: hoursBefore(1) });
      const categoryId = await insertCategory(userId);
      const ruleId = await insertRule(userId, categoryId, {
        startDate: today,
        nextOccurrence: today,
      });

      // The failure mode that actually happens on a bad night: the run itself
      // is fine and one rule cannot be written. `generateRecurring` catches
      // that per rule and keeps going, so unless `runNightly` carries the
      // report out, the CLI sees an empty `failures` and exits 0 on a night
      // where nothing was generated. Non-emptiness is not enough to assert —
      // the rule id is the only thing that makes the line actionable, so the
      // prefix is pinned too.
      //
      // Same probe as demo.test.ts's rollback test: a CHECK no row can
      // satisfy, added NOT VALID so the rows already in the table are left
      // alone and only new inserts fail.
      await db.execute(
        sql`alter table expenses add constraint nightly_failure_probe check (false) not valid`,
      );
      let result;
      try {
        result = await runNightly(db, NOW);
      } finally {
        await db.execute(
          sql`alter table expenses drop constraint nightly_failure_probe`,
        );
      }

      // The run took responsibility for the rule and wrote nothing for it.
      expect(result.rulesProcessed).toBe(1);
      expect(result.inserted).toBe(0);
      expect(result.skipped).toBe(0);

      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toMatch(
        new RegExp(`^generate rule ${ruleId}: `),
      );
      // The Postgres error, not drizzle's wrapper — whose message is the whole
      // INSERT plus every bound parameter. `failures` is printed by the CLI
      // into CI output, so the wrapper would put a user's descriptions and
      // amounts there on every bad rule.
      expect(result.failures[0]).toContain("nightly_failure_probe");
      expect(result.failures[0]).not.toContain("insert into");
    });

    it("still generates normally once the probe is gone", async () => {
      // Guards the probe itself: a leaked constraint would fail every later
      // test in this file for the wrong reason.
      const today = todayUtc();
      const userId = await insertUser({ createdAt: hoursBefore(1) });
      const categoryId = await insertCategory(userId);
      await insertRule(userId, categoryId, {
        startDate: today,
        nextOccurrence: today,
      });

      const result = await runNightly(db, NOW);

      expect(result.inserted).toBe(1);
      expect(result.failures).toEqual([]);
    });
  });

  describe("failure semantics", () => {
    it("runs steps 1 and 3 even when step 2 throws, and reports exactly one failure", async () => {
      const today = todayUtc();
      const doomed = await insertFullUser({
        isDemo: true,
        createdAt: hoursBefore(25),
      });
      const owner = await insertUser({ createdAt: hoursBefore(1) });
      const categoryId = await insertCategory(owner);
      const ruleId = await insertRule(owner, categoryId, {
        startDate: today,
        nextOccurrence: today,
      });
      // Step 2's own work, which must be left undone by the injected failure.
      await insertSession(owner, hoursBefore(1));

      const lines: string[] = [];
      const logger = pino(
        { level: "info" },
        {
          write: (line: string) => {
            lines.push(line);
          },
        },
      );

      // The seam is `db.delete`, which both step 1 and step 2 go through — so
      // the mock has to fail step 2 *only*, otherwise the test proves nothing
      // about steps running independently.
      const realDelete = db.delete.bind(db);
      const spy = vi.spyOn(db, "delete").mockImplementation(((
        table: PgTable,
      ) => {
        if (table === sessions) throw new Error("injected sweep failure");
        return realDelete(table);
      }) as typeof db.delete);

      let result;
      try {
        result = await runNightly(db, NOW, { logger });
      } finally {
        spy.mockRestore();
      }

      // Exactly one — the failure is recorded once, not once per step that
      // follows it, and the generator contributed none of its own.
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]).toContain("injected sweep failure");

      // Step 1 ran: the stale demo user is gone.
      expect(result.reaped).toBe(1);
      expect(await rowCounts(doomed)).toEqual(NOTHING);

      // Step 2 did not: its expired session is still there.
      expect(result.sweptSessions).toBe(0);
      const left = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.userId, owner));
      expect(left).toHaveLength(1);

      // Step 3 ran: the due rule generated its occurrence.
      expect(result.inserted).toBe(1);
      const generated = await db
        .select({ id: expenses.id })
        .from(expenses)
        .where(eq(expenses.recurringRuleId, ruleId));
      expect(generated).toHaveLength(1);

      // One run id, on the result and on every line all three steps logged.
      expect(result.runId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(lines.length).toBeGreaterThanOrEqual(3);
      for (const line of lines) {
        expect(JSON.parse(line)).toMatchObject({ runId: result.runId });
      }
    });
  });
});
