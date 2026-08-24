import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expenses, recurringRules } from "../../src/db/schema.js";
import { firstOccurrenceOnOrAfter } from "../../src/domain/recurring.js";
import { addDays, todayUtc } from "../../src/lib/dates.js";
import { newId } from "../../src/lib/ids.js";
import { asUser, makeTestApp, signupUser } from "../helpers.js";

/**
 * Task 13, Step 3 — recurring rules CRUD.
 *
 * The rule worth stating out loud is amendment B: PATCH recomputes
 * `next_occurrence` only when the schedule itself changes (`frequency` or
 * `startDate` in the patch body). A rule whose cursor is in the past is a rule
 * mid-catch-up — the generator has not run yet — and an unconditional
 * recompute on, say, a description edit would silently move the cursor forward
 * and lose the missed occurrence with no error anywhere.
 */

let app: Awaited<ReturnType<typeof makeTestApp>>["app"];
let db: Awaited<ReturnType<typeof makeTestApp>>["db"];
let stop: (() => Promise<void>) | undefined;
let api: ReturnType<typeof asUser>;
let asOther: ReturnType<typeof asUser>;
let foodId: string;
let othersFoodId: string;

interface RuleDto {
  id: string;
  categoryId: string;
  amountMinor: number;
  currency: string;
  description: string;
  notes: string | null;
  frequency: "weekly" | "monthly";
  startDate: string;
  endDate: string | null;
  nextOccurrence: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * The clock, sampled exactly once. Three independent `todayUtc()` reads could
 * straddle UTC midnight and disagree with each other mid-suite; one read
 * cannot.
 */
const TODAY = todayUtc();
/** Anchored well in the past, so "no backfill" has something to not backfill. */
const PAST_START = addDays(TODAY, -200);
const FUTURE_START = addDays(TODAY, 45);

const A_VALID_RULE = () => ({
  categoryId: foodId,
  amountMinor: 250_000,
  description: "Gym membership",
  frequency: "monthly" as const,
  startDate: PAST_START,
});

async function create(
  overrides: Record<string, unknown> = {},
): Promise<RuleDto> {
  const r = await api.post("/api/recurring-rules", {
    ...A_VALID_RULE(),
    ...overrides,
  });
  if (r.statusCode !== 201) {
    throw new Error(`create -> ${r.statusCode} ${r.body}`);
  }
  return r.json().rule as RuleDto;
}

/** Sets the stored cursor directly, as a missed cron night would leave it. */
async function setCursor(ruleId: string, date: string): Promise<void> {
  await db
    .update(recurringRules)
    .set({ nextOccurrence: date })
    .where(eq(recurringRules.id, ruleId));
}

async function storedCursor(ruleId: string): Promise<string | undefined> {
  const [row] = await db
    .select()
    .from(recurringRules)
    .where(eq(recurringRules.id, ruleId));
  return row?.nextOccurrence;
}

/** Creates an archived category and returns its id. */
async function archivedCategory(name: string): Promise<string> {
  const created = await api.post("/api/categories", { name });
  const { id } = created.json().category as { id: string };
  const archived = await api.patch(`/api/categories/${id}`, { archived: true });
  expect(archived.statusCode).toBe(200);
  return id;
}

beforeAll(async () => {
  const t = await makeTestApp();
  app = t.app;
  db = t.db;
  stop = t.stop;
  await app.ready();

  api = asUser(app, await signupUser(app, "recurrer"));
  asOther = asUser(app, await signupUser(app, "recurring-other"));

  const findFood = async (as: ReturnType<typeof asUser>) => {
    const items = (await as.get("/api/categories")).json().items as {
      id: string;
      name: string;
    }[];
    return items.find((c) => c.name === "Food")!.id;
  };
  foodId = await findFood(api);
  othersFoodId = await findFood(asOther);
}, 120_000);

afterAll(() => stop?.());

describe("POST /api/recurring-rules", () => {
  it("401s without a session", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/recurring-rules",
      payload: A_VALID_RULE(),
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe("unauthorized");
  });

  it("echoes a computed nextOccurrence; client cannot supply one", async () => {
    const rule = await create({ nextOccurrence: "1999-01-01" });

    // Unknown keys are stripped by the shared schema, so the client's value
    // never reaches the server's computation.
    expect(rule.nextOccurrence).not.toBe("1999-01-01");
    expect(rule.nextOccurrence).toBe(
      firstOccurrenceOnOrAfter(
        { frequency: "monthly", startDate: PAST_START },
        TODAY,
      ),
    );
    expect(Object.keys(rule).sort()).toEqual([
      "amountMinor",
      "categoryId",
      "createdAt",
      "currency",
      "description",
      "endDate",
      "frequency",
      "id",
      "nextOccurrence",
      "notes",
      "startDate",
      "updatedAt",
    ]);
    expect(rule.currency).toBe("LKR");
    expect(rule.endDate).toBeNull();
    expect(rule.notes).toBeNull();
  });

  it("past startDate -> nextOccurrence >= today (no backfill)", async () => {
    const rule = await create({ startDate: PAST_START });
    // The exact first on-or-after-today date — not a bare `>= today` boolean,
    // which fails as "expected false to be true" and names nothing.
    expect(rule.nextOccurrence).toBe(
      firstOccurrenceOnOrAfter(
        { frequency: "monthly", startDate: PAST_START },
        TODAY,
      ),
    );
  });

  it("future startDate -> nextOccurrence === startDate", async () => {
    const rule = await create({ startDate: FUTURE_START });
    expect(rule.nextOccurrence).toBe(FUTURE_START);
  });

  it("404s on an unowned categoryId, same body as a nonexistent one", async () => {
    const othersRow = await api.post("/api/recurring-rules", {
      ...A_VALID_RULE(),
      categoryId: othersFoodId,
    });
    const noRow = await api.post("/api/recurring-rules", {
      ...A_VALID_RULE(),
      categoryId: newId(),
    });

    expect(othersRow.statusCode).toBe(404);
    expect(noRow.statusCode).toBe(404);
    expect(noRow.body).toBe(othersRow.body);
    // The mapping table's message, not the app's catch-all "Not found" — this
    // is what proves the request reached the route's category check.
    expect(noRow.json().error.message).toBe("Category not found");
  });

  it("400s validation_failed on categoryId when the category is archived", async () => {
    const id = await archivedCategory("Retired");

    const r = await api.post("/api/recurring-rules", {
      ...A_VALID_RULE(),
      categoryId: id,
    });
    expect(r.statusCode).toBe(400);
    const { error } = r.json();
    expect(error.code).toBe("validation_failed");
    expect(error.details).toEqual([
      { path: "categoryId", message: "category is archived" },
    ]);
  });
});

describe("PATCH /api/recurring-rules/:id", () => {
  it("frequency recomputes nextOccurrence", async () => {
    const rule = await create();
    // A sentinel the recompute cannot produce: proof the cursor moved because
    // the schedule changed, not because the sentinel happened to match.
    const sentinel = addDays(TODAY, -60);
    await setCursor(rule.id, sentinel);

    const r = await api.patch(`/api/recurring-rules/${rule.id}`, {
      frequency: "weekly",
    });

    expect(r.statusCode).toBe(200);
    const patched = r.json().rule as RuleDto;
    expect(patched.nextOccurrence).not.toBe(sentinel);
    expect(patched.nextOccurrence).toBe(
      firstOccurrenceOnOrAfter(
        { frequency: "weekly", startDate: rule.startDate },
        TODAY,
      ),
    );
  });

  it("startDate recomputes nextOccurrence", async () => {
    const rule = await create();

    const r = await api.patch(`/api/recurring-rules/${rule.id}`, {
      startDate: FUTURE_START,
    });

    expect(r.statusCode).toBe(200);
    // A future anchor's first occurrence is the anchor itself.
    expect((r.json().rule as RuleDto).nextOccurrence).toBe(FUTURE_START);
  });

  it("description alone leaves nextOccurrence untouched", async () => {
    // Amendment B. The cursor is in the past — the generator missed a night
    // and has not caught up. A description edit is not a schedule change, so
    // the missed occurrence must still be pending afterwards.
    const rule = await create();
    const pastDue = addDays(TODAY, -60);
    await setCursor(rule.id, pastDue);

    const r = await api.patch(`/api/recurring-rules/${rule.id}`, {
      description: "Renamed mid-catch-up",
    });

    expect(r.statusCode).toBe(200);
    const patched = r.json().rule as RuleDto;
    expect(patched.description).toBe("Renamed mid-catch-up");
    expect(patched.nextOccurrence).toBe(pastDue);
    expect(await storedCursor(rule.id)).toBe(pastDue);
  });

  it("400s when endDate is before startDate — the shared schema refinement", async () => {
    const rule = await create();

    const r = await api.patch(`/api/recurring-rules/${rule.id}`, {
      startDate: "2026-05-01",
      endDate: "2026-04-30",
    });

    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("validation_failed");
  });

  it("400s when endDate alone lands before the stored startDate", async () => {
    // The wire refinement cannot see the stored row, so with one bound in the
    // patch the server re-checks against the other bound in the database —
    // otherwise this request reaches the CHECK constraint and surfaces as a
    // 500 instead of a validation error.
    const rule = await create({ startDate: FUTURE_START });

    const r = await api.patch(`/api/recurring-rules/${rule.id}`, {
      endDate: addDays(FUTURE_START, -1),
    });

    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("validation_failed");
  });

  it("404s on an unowned categoryId, same body as a nonexistent one", async () => {
    // PATCH must run the same category check as POST: wiring `checkUsable`
    // into create alone would leave PATCH a way to point a rule at a category
    // the user does not own.
    const rule = await create();

    const othersRow = await api.patch(`/api/recurring-rules/${rule.id}`, {
      categoryId: othersFoodId,
    });
    const noRow = await api.patch(`/api/recurring-rules/${rule.id}`, {
      categoryId: newId(),
    });

    expect(othersRow.statusCode).toBe(404);
    expect(noRow.statusCode).toBe(404);
    expect(noRow.body).toBe(othersRow.body);
    expect(noRow.json().error.message).toBe("Category not found");
  });

  it("400s validation_failed when moving to an archived category", async () => {
    const rule = await create();
    const id = await archivedCategory("Retired Too");

    const r = await api.patch(`/api/recurring-rules/${rule.id}`, {
      categoryId: id,
    });
    expect(r.statusCode).toBe(400);
    const { error } = r.json();
    expect(error.code).toBe("validation_failed");
    expect(error.details).toEqual([
      { path: "categoryId", message: "category is archived" },
    ]);
  });

  it("404s on an id that is not a rule of this user", async () => {
    const r = await api.patch(`/api/recurring-rules/${newId()}`, {
      description: "Nope",
    });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe("not_found");
    expect(r.json().error.message).toBe("Recurring rule not found");
  });
});

describe("DELETE /api/recurring-rules/:id", () => {
  it("204s; generated expenses survive with recurringRuleId null", async () => {
    const rule = await create();
    // What the generator (Task 14) will write: an expense pointing back at its
    // rule. Inserted directly because POST /api/expenses ignores
    // `recurringRuleId` — it is server-derived, never client-supplied.
    const expenseId = newId();
    await db.insert(expenses).values({
      id: expenseId,
      userId: api.user.userId,
      categoryId: foodId,
      recurringRuleId: rule.id,
      amountMinor: 250_000,
      date: rule.startDate,
      description: "Generated by the rule",
    });

    const r = await api.delete(`/api/recurring-rules/${rule.id}`);
    expect(r.statusCode).toBe(204);
    expect(r.body).toBe("");

    // FK ON DELETE SET NULL: the history survives, only the link is gone.
    const [row] = await db
      .select()
      .from(expenses)
      .where(eq(expenses.id, expenseId));
    expect(row).toBeDefined();
    expect(row?.recurringRuleId).toBeNull();

    // And a second delete is a 404, not a second success.
    expect(
      (await api.delete(`/api/recurring-rules/${rule.id}`)).statusCode,
    ).toBe(404);
  });

  it("404s on an id that is not a rule of this user", async () => {
    const r = await api.delete(`/api/recurring-rules/${newId()}`);
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe("not_found");
    expect(r.json().error.message).toBe("Recurring rule not found");
  });
});

describe("GET /api/recurring-rules", () => {
  it("lists only the caller's rules", async () => {
    const mine = await create({ description: "Mine" });

    const theirs = await asOther.post("/api/recurring-rules", {
      ...A_VALID_RULE(),
      categoryId: othersFoodId,
      description: "Theirs",
    });
    expect(theirs.statusCode).toBe(201);
    const theirId = (theirs.json().rule as RuleDto).id;

    const mineListed = (await api.get("/api/recurring-rules")).json()
      .items as RuleDto[];
    expect(mineListed.map((r) => r.id)).toContain(mine.id);
    expect(mineListed.map((r) => r.id)).not.toContain(theirId);

    const theirsListed = (await asOther.get("/api/recurring-rules")).json()
      .items as RuleDto[];
    expect(theirsListed.map((r) => r.id)).toEqual([theirId]);
  });

  it("orders by nextOccurrence ASC, id ASC — soonest due first", async () => {
    // A fresh user, so the list holds exactly these rules and the assertion
    // can be on the whole ordering rather than a subsequence.
    const asSorter = asUser(app, await signupUser(app, "rule-sorter"));
    const catId = (
      (await asSorter.get("/api/categories")).json().items as {
        id: string;
        name: string;
      }[]
    ).find((c) => c.name === "Food")!.id;

    // Future startDates pin nextOccurrence exactly (=== startDate), and the
    // insert order deliberately disagrees with the due order.
    const post = async (startDate: string) => {
      const r = await asSorter.post("/api/recurring-rules", {
        categoryId: catId,
        amountMinor: 10_000,
        description: `due ${startDate}`,
        frequency: "monthly",
        startDate,
      });
      expect(r.statusCode).toBe(201);
      return (r.json().rule as RuleDto).id;
    };
    const dueLast = await post(addDays(TODAY, 40));
    const dueFirst = await post(addDays(TODAY, 10));
    const dueSecond = await post(addDays(TODAY, 25));
    // Same due date as dueSecond: the tie breaks on id, and UUIDv7 ids are
    // time-ordered, so creation order is id order.
    const dueSecondTie = await post(addDays(TODAY, 25));

    const listed = (await asSorter.get("/api/recurring-rules")).json()
      .items as RuleDto[];
    expect(listed.map((r) => r.id)).toEqual([
      dueFirst,
      dueSecond,
      dueSecondTie,
      dueLast,
    ]);
  });
});
