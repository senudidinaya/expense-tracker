import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { expenses, recurringRules } from "../../src/db/schema.js";
import { newId } from "../../src/lib/ids.js";
import { generateRecurring } from "../../src/jobs/generate-recurring.js";
import { makeTestApp, signupUser } from "../helpers.js";

/**
 * Task 14, Step 1 — the idempotent catch-up generator.
 *
 * Every date here is a fixed literal and `today` is always the injected
 * parameter: the generator never reads the clock, so a suite pinned to
 * early 2026 stays green in any month, and the awkward calendar cases (the
 * Jan 31 clamp) can be asserted exactly rather than approximated.
 *
 * The two idempotency guards are tested separately on purpose, and the
 * distinction is the whole point of this file (CLAUDE.md):
 *
 *  - the CURSOR (`recurring_rules.next_occurrence`) is an application-level
 *    belief, read at the start of a run and written at the end. It stops a
 *    second run from finding the rule due at all — the insert never executes.
 *  - the CONSTRAINT (`expenses_rule_date_uq` + ON CONFLICT DO NOTHING) is
 *    checked by Postgres against committed state at write time. It is what
 *    holds when two runs overlap and the cursor is stale.
 *
 * "run it twice, nothing happens" only exercises the cursor: with the unique
 * index dropped that test still passes, because the second run's SELECT
 * returns nothing. The constraint test therefore resets the cursor first, so
 * the insert path really does run against rows that already exist.
 */

let app: Awaited<ReturnType<typeof makeTestApp>>["app"];
let db: Awaited<ReturnType<typeof makeTestApp>>["db"];
let stop: (() => Promise<void>) | undefined;

/** Seeded once; the per-test fixture is rules and expenses, wiped each test. */
let userA: string;
let userB: string;
let foodA: string;
let foodB: string;
let archivedA: string;

interface RuleFields {
  userId?: string;
  categoryId?: string;
  amountMinor?: number;
  description?: string;
  notes?: string | null;
  frequency?: "weekly" | "monthly";
  startDate: string;
  endDate?: string | null;
  nextOccurrence: string;
}

/**
 * Rules are inserted straight into the table rather than through
 * `POST /api/recurring-rules`, because that route derives `next_occurrence`
 * from the real clock. What the generator consumes is a stored cursor, and a
 * catch-up test is precisely one where that cursor sits in the past.
 */
async function insertRule(fields: RuleFields): Promise<string> {
  const id = newId();
  await db.insert(recurringRules).values({
    id,
    userId: fields.userId ?? userA,
    categoryId: fields.categoryId ?? foodA,
    amountMinor: fields.amountMinor ?? 125_000,
    currency: "LKR",
    description: fields.description ?? "Rent",
    notes: fields.notes ?? null,
    frequency: fields.frequency ?? "monthly",
    startDate: fields.startDate,
    endDate: fields.endDate ?? null,
    nextOccurrence: fields.nextOccurrence,
  });
  return id;
}

const rowsForRule = (ruleId: string) =>
  db
    .select()
    .from(expenses)
    .where(eq(expenses.recurringRuleId, ruleId))
    .orderBy(expenses.date);

const datesForRule = async (ruleId: string): Promise<string[]> =>
  (await rowsForRule(ruleId)).map((r) => r.date);

const rowsForUser = (userId: string) =>
  db.select().from(expenses).where(eq(expenses.userId, userId));

async function cursorOf(ruleId: string): Promise<string> {
  const [row] = await db
    .select()
    .from(recurringRules)
    .where(eq(recurringRules.id, ruleId));
  if (!row) throw new Error(`rule ${ruleId} vanished`);
  return row.nextOccurrence;
}

beforeAll(async () => {
  const t = await makeTestApp();
  app = t.app;
  db = t.db;
  stop = t.stop;
  await app.ready();

  const a = await signupUser(app, "generator-a");
  const b = await signupUser(app, "generator-b");
  userA = a.userId;
  userB = b.userId;

  const categoriesOf = async (token: string) => {
    const r = await app.inject({
      method: "GET",
      url: "/api/categories",
      cookies: { session: token },
    });
    return r.json().items as { id: string; name: string }[];
  };
  foodA = (await categoriesOf(a.token)).find((c) => c.name === "Food")!.id;
  foodB = (await categoriesOf(b.token)).find((c) => c.name === "Food")!.id;

  // Archived up front, while no rule references it — nothing here for an
  // archive conflict to trip over yet.
  const created = await app.inject({
    method: "POST",
    url: "/api/categories",
    payload: { name: "Streaming" },
    cookies: { session: a.token },
  });
  archivedA = created.json().category.id as string;
  const archived = await app.inject({
    method: "PATCH",
    url: `/api/categories/${archivedA}`,
    payload: { archived: true },
    cookies: { session: a.token },
  });
  expect(archived.statusCode).toBe(200);
}, 120_000);

afterAll(() => stop?.());

/**
 * The generator sweeps every due rule in the database, so leftovers from one
 * test would land in the next one's counts. Users and categories are stable.
 */
beforeEach(async () => {
  await db.delete(expenses);
  await db.delete(recurringRules);
});

describe("generateRecurring", () => {
  it("inserts the due occurrence and advances next_occurrence past today", async () => {
    const ruleId = await insertRule({
      startDate: "2026-01-05",
      nextOccurrence: "2026-03-05",
      amountMinor: 85_000_00,
      description: "Rent",
    });

    const result = await generateRecurring(db, "2026-03-10");

    expect(result).toEqual({
      rulesProcessed: 1,
      inserted: 1,
      skipped: 0,
      failures: [],
    });

    const rows = await rowsForRule(ruleId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.date).toBe("2026-03-05");
    expect(row.userId).toBe(userA);
    expect(row.categoryId).toBe(foodA);
    expect(row.amountMinor).toBe(85_000_00);
    expect(row.currency).toBe("LKR");
    expect(row.description).toBe("Rent");
    // A generated expense is a new row, not a copy of the rule: spreading the
    // rule would carry `rule.id` straight into the primary key.
    expect(row.id).not.toBe(ruleId);

    expect(await cursorOf(ruleId)).toBe("2026-04-05");
  });

  it("catches up a weekly rule that missed three occurrences", async () => {
    const ruleId = await insertRule({
      frequency: "weekly",
      startDate: "2026-01-02",
      nextOccurrence: "2026-02-06",
      description: "Groceries",
    });

    const result = await generateRecurring(db, "2026-02-20");

    expect(result.inserted).toBe(3);
    expect(await datesForRule(ruleId)).toEqual([
      "2026-02-06",
      "2026-02-13",
      "2026-02-20",
    ]);
    expect(await cursorOf(ruleId)).toBe("2026-02-27");
  });

  it("CURSOR guard: a second run the same day finds nothing due", async () => {
    const ruleId = await insertRule({
      startDate: "2026-01-05",
      nextOccurrence: "2026-03-05",
    });

    const first = await generateRecurring(db, "2026-03-10");
    expect(first.inserted).toBe(1);

    // The cursor now sits past today, so the rule is not even selected.
    const second = await generateRecurring(db, "2026-03-10");
    expect(second.rulesProcessed).toBe(0);
    expect(second.inserted).toBe(0);
    expect(second.failures).toEqual([]);
    expect(await datesForRule(ruleId)).toEqual(["2026-03-05"]);
  });

  it("CONSTRAINT guard: a stale cursor re-runs the insert and conflicts away", async () => {
    const ruleId = await insertRule({
      startDate: "2026-01-05",
      nextOccurrence: "2026-03-05",
    });

    await generateRecurring(db, "2026-03-10");

    // Exactly what an overlapping run holds: the cursor as it was before the
    // first run committed. The rule is due again and the insert really runs —
    // only `expenses_rule_date_uq` stops the duplicate.
    await db
      .update(recurringRules)
      .set({ nextOccurrence: "2026-03-05" })
      .where(eq(recurringRules.id, ruleId));

    const second = await generateRecurring(db, "2026-03-10");
    expect(second.rulesProcessed).toBe(1);
    expect(second.inserted).toBe(0);
    expect(second.failures).toEqual([]);
    expect(await datesForRule(ruleId)).toEqual(["2026-03-05"]);
    expect(await cursorOf(ruleId)).toBe("2026-04-05");
  });

  it("does not throw or double-insert when the occurrence row already exists", async () => {
    const ruleId = await insertRule({
      startDate: "2026-01-05",
      nextOccurrence: "2026-03-05",
    });
    // The row a concurrent run committed a moment ago.
    await db.insert(expenses).values({
      id: newId(),
      userId: userA,
      categoryId: foodA,
      recurringRuleId: ruleId,
      amountMinor: 125_000,
      currency: "LKR",
      date: "2026-03-05",
      description: "written by the other run",
    });

    const result = await generateRecurring(db, "2026-03-10");

    expect(result.inserted).toBe(0);
    expect(result.failures).toEqual([]);
    const rows = await rowsForRule(ruleId);
    expect(rows).toHaveLength(1);
    // DO NOTHING, not DO UPDATE: the existing row is left exactly as it was.
    expect(rows[0]!.description).toBe("written by the other run");
  });

  it("counts only the rows it wrote when part of a catch-up already exists", async () => {
    const ruleId = await insertRule({
      frequency: "weekly",
      startDate: "2026-01-02",
      nextOccurrence: "2026-02-06",
      description: "Groceries",
    });
    // The middle of three due occurrences, committed by an overlapping run.
    // Partial rather than total: the other two conflict tests are single
    // occurrences, so 0-vs-1 cannot tell "rows written" apart from arithmetic
    // that happens to agree at the boundaries.
    await db.insert(expenses).values({
      id: newId(),
      userId: userA,
      categoryId: foodA,
      recurringRuleId: ruleId,
      amountMinor: 125_000,
      currency: "LKR",
      date: "2026-02-13",
      description: "written by the other run",
    });

    const result = await generateRecurring(db, "2026-02-20");

    // Two written, one conflicted away — not the three occurrences that were
    // due, and not a flat 0 because one of them collided.
    expect(result.inserted).toBe(2);
    expect(result.failures).toEqual([]);
    // Every date exactly once: the conflict skipped a row rather than
    // aborting the statement and losing its two healthy siblings.
    expect(await datesForRule(ruleId)).toEqual([
      "2026-02-06",
      "2026-02-13",
      "2026-02-20",
    ]);
    const middle = (await rowsForRule(ruleId)).find(
      (r) => r.date === "2026-02-13",
    );
    expect(middle!.description).toBe("written by the other run");
    expect(await cursorOf(ruleId)).toBe("2026-02-27");
  });

  it("generates nothing past endDate and advances the cursor beyond it", async () => {
    const ruleId = await insertRule({
      startDate: "2026-01-10",
      endDate: "2026-02-10",
      nextOccurrence: "2026-03-10",
    });

    const result = await generateRecurring(db, "2026-06-15");

    expect(result.rulesProcessed).toBe(1);
    expect(result.inserted).toBe(0);
    expect(result.skipped).toBe(0);
    expect(await datesForRule(ruleId)).toEqual([]);
    // Past endDate, so `next_occurrence <= today` is never true again — the
    // rule stops matching rather than needing a state flag.
    expect(await cursorOf(ruleId)).toBe("2026-07-10");
  });

  it("applies the anchor clamp end to end across February", async () => {
    const ruleId = await insertRule({
      startDate: "2026-01-31",
      nextOccurrence: "2026-01-31",
      description: "Loan instalment",
    });

    await generateRecurring(db, "2026-03-31");

    // The invariant made visible: March is the 31st, not the 28th that
    // incrementing the clamped February date would give.
    expect(await datesForRule(ruleId)).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
    ]);
    expect(await cursorOf(ruleId)).toBe("2026-04-30");
  });

  it("writes each occurrence under its own rule's user", async () => {
    const manualId = newId();
    await db.insert(expenses).values({
      id: manualId,
      userId: userA,
      categoryId: foodA,
      amountMinor: 40_000,
      currency: "LKR",
      date: "2026-04-01",
      description: "A's own expense",
    });
    const ruleA = await insertRule({
      startDate: "2026-01-15",
      nextOccurrence: "2026-04-15",
    });
    const ruleB = await insertRule({
      userId: userB,
      categoryId: foodB,
      startDate: "2026-01-15",
      nextOccurrence: "2026-04-15",
    });

    const result = await generateRecurring(db, "2026-04-20");
    expect(result.inserted).toBe(2);

    for (const row of await rowsForRule(ruleA)) {
      expect(row.userId).toBe(userA);
      expect(row.categoryId).toBe(foodA);
    }
    for (const row of await rowsForRule(ruleB)) {
      expect(row.userId).toBe(userB);
      expect(row.categoryId).toBe(foodB);
    }
    // B's rule added nothing to A: A has the manual row plus A's occurrence.
    const aRows = await rowsForUser(userA);
    expect(aRows).toHaveLength(2);
    expect(aRows.map((r) => r.id)).toContain(manualId);
    expect(await rowsForUser(userB)).toHaveLength(1);
  });

  it("skips a rule whose category is archived, advancing its cursor anyway", async () => {
    const ruleId = await insertRule({
      categoryId: archivedA,
      startDate: "2026-01-20",
      nextOccurrence: "2026-02-20",
    });

    const result = await generateRecurring(db, "2026-05-01");

    // The API returns 400 on a manual create into an archived category; a
    // background job must not be able to write the row a user cannot.
    expect(result.inserted).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.rulesProcessed).toBe(1);
    expect(await datesForRule(ruleId)).toEqual([]);
    // Advanced, so the skip is permanent and visible rather than a backlog
    // that would dump every missed occurrence at once on unarchive.
    expect(await cursorOf(ruleId)).toBe("2026-05-20");
  });

  it("records a failing rule and still generates the others", async () => {
    // A real database-level failure on one rule's insert, so the per-rule
    // transaction genuinely aborts — a run wrapped in a single transaction
    // would lose the healthy rule's row along with it.
    await db.execute(
      sql.raw(
        "create function raise_on_boom() returns trigger language plpgsql as " +
          "$fn$ begin raise exception 'forced failure for test'; end $fn$",
      ),
    );
    await db.execute(
      sql.raw(
        "create trigger expenses_boom before insert on expenses for each row " +
          "when (new.description = 'BOOM') execute function raise_on_boom()",
      ),
    );

    try {
      const boomId = await insertRule({
        description: "BOOM",
        startDate: "2026-01-05",
        nextOccurrence: "2026-03-05",
      });
      const goodId = await insertRule({
        description: "Rent",
        startDate: "2026-01-07",
        nextOccurrence: "2026-03-07",
      });

      const result = await generateRecurring(db, "2026-03-10");

      expect(result.rulesProcessed).toBe(2);
      expect(result.inserted).toBe(1);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]!.startsWith(`${boomId}:`)).toBe(true);

      expect(await datesForRule(goodId)).toEqual(["2026-03-07"]);
      expect(await cursorOf(goodId)).toBe("2026-04-07");
      // Rolled back whole: no row, and the cursor did not move, so the next
      // run retries the occurrence rather than silently dropping it.
      expect(await datesForRule(boomId)).toEqual([]);
      expect(await cursorOf(boomId)).toBe("2026-03-05");
    } finally {
      await db.execute(sql.raw("drop trigger expenses_boom on expenses"));
      await db.execute(sql.raw("drop function raise_on_boom()"));
    }
  });
});
