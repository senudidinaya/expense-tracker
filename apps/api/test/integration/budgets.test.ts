import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newId } from "../../src/lib/ids.js";
import { asUser, makeTestApp, signupUser } from "../helpers.js";

/**
 * Task 11, Step 2 — budgets over HTTP.
 *
 * design/api.md: `GET /api/budgets?month=` resolves the effective budget per
 * category for that month, `PUT /api/budgets` upserts the row at one month and
 * never touches history. The domain unit tests already pin the resolution rule;
 * what these add is that the rule survives the round trip through Postgres —
 * the upsert lands on the unique triple, the DATE column comes back as the
 * `YYYY-MM` the wire speaks, and a category that is not yours is a 404 that
 * looks exactly like a category that is not there.
 */

let app: Awaited<ReturnType<typeof makeTestApp>>["app"];
let stop: (() => Promise<void>) | undefined;
let api: ReturnType<typeof asUser>;
let other: ReturnType<typeof asUser>;

interface CategoryDto {
  id: string;
  name: string;
  archivedAt: string | null;
}

interface BudgetDto {
  id: string;
  categoryId: string;
  month: string;
  amountMinor: number | null;
  currency: "LKR";
  createdAt: string;
  updatedAt: string;
}

interface EffectiveBudgetDto {
  categoryId: string;
  amountMinor: number | null;
  effectiveFrom: string;
}

/** A valid uuid that belongs to nobody — what "not there" looks like. */
const NOWHERE_ID = newId();

let food: CategoryDto;
let transport: CategoryDto;
/** Owned by the *other* user, so it exists but is not ours. */
let theirs: CategoryDto;

const categories = async (
  client: ReturnType<typeof asUser>,
): Promise<CategoryDto[]> => {
  const r = await client.get("/api/categories");
  expect(r.statusCode).toBe(200);
  return r.json().items as CategoryDto[];
};

const named = (items: CategoryDto[], name: string): CategoryDto => {
  const found = items.find((c) => c.name === name);
  if (!found) throw new Error(`no seeded category named "${name}"`);
  return found;
};

/** PUT that must succeed, returning the upserted row. */
async function put(
  categoryId: string,
  month: string,
  amountMinor: number | null,
): Promise<BudgetDto> {
  const r = await api.put("/api/budgets", { categoryId, month, amountMinor });
  if (r.statusCode !== 200) {
    throw new Error(`PUT ${month}=${amountMinor} -> ${r.statusCode} ${r.body}`);
  }
  return r.json().budget as BudgetDto;
}

/** The effective budget for one category in one month, or `undefined`. */
async function effective(
  month: string,
  categoryId: string,
): Promise<EffectiveBudgetDto | undefined> {
  const r = await api.get(`/api/budgets?month=${month}`);
  expect(r.statusCode).toBe(200);
  return (r.json().items as EffectiveBudgetDto[]).find(
    (b) => b.categoryId === categoryId,
  );
}

beforeAll(async () => {
  const t = await makeTestApp();
  app = t.app;
  stop = t.stop;
  await app.ready();

  api = asUser(app, await signupUser(app, "budgets"));
  other = asUser(app, await signupUser(app, "budgets-other"));

  const mine = await categories(api);
  food = named(mine, "Food");
  transport = named(mine, "Transport");
  theirs = named(await categories(other), "Food");
}, 120_000);

afterAll(() => stop?.());

describe("GET /api/budgets", () => {
  it("401s without a session", async () => {
    const r = await app.inject({
      method: "GET",
      url: "/api/budgets?month=2026-03",
    });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe("unauthorized");
  });

  it("400s on a month that is not YYYY-MM", async () => {
    for (const month of ["2026-3", "2026-13", "march", "2026-03-01"]) {
      const r = await api.get(`/api/budgets?month=${month}`);
      expect(r.statusCode, month).toBe(400);
      expect(r.json().error.code).toBe("validation_failed");
    }
  });

  it("400s when month is missing entirely", async () => {
    const r = await api.get("/api/budgets");
    expect(r.statusCode).toBe(400);
  });
});

/**
 * The scenario from the plan: Jan = 10000, Mar = cleared. Every month between
 * and after is answered from those two rows alone — no row is written for
 * February, and none is needed.
 */
describe("effective-from resolution across months", () => {
  it("carries a budget forward, clears it from the month it was cleared in", async () => {
    await put(food.id, "2026-01", 10_000);
    await put(food.id, "2026-03", null);

    // Before anything was set: no row, so the category is absent entirely.
    expect(await effective("2025-12", food.id)).toBeUndefined();

    // January itself, and February from January's row.
    expect(await effective("2026-01", food.id)).toEqual({
      categoryId: food.id,
      amountMinor: 10_000,
      effectiveFrom: "2026-01",
    });
    expect(await effective("2026-02", food.id)).toEqual({
      categoryId: food.id,
      amountMinor: 10_000,
      effectiveFrom: "2026-01",
    });

    // March clears it, and the clear carries forward exactly like an amount.
    expect(await effective("2026-03", food.id)).toEqual({
      categoryId: food.id,
      amountMinor: null,
      effectiveFrom: "2026-03",
    });
    expect(await effective("2026-04", food.id)).toEqual({
      categoryId: food.id,
      amountMinor: null,
      effectiveFrom: "2026-03",
    });
  });

  /**
   * The provenance distinction, at the API surface rather than in the pure
   * function. A cleared budget is a decision with a month attached; no budget
   * at all is the absence of one. Both render as "unbudgeted" in the UI, and
   * the response still tells them apart — the cleared category is an item whose
   * `amountMinor` is null, the never-budgeted one is not an item at all.
   */
  it("distinguishes a cleared budget from one that was never set", async () => {
    const items = async (month: string) =>
      (await api.get(`/api/budgets?month=${month}`)).json()
        .items as EffectiveBudgetDto[];

    const april = await items("2026-04");
    const cleared = april.find((b) => b.categoryId === food.id);
    expect(cleared).toEqual({
      categoryId: food.id,
      amountMinor: null,
      effectiveFrom: "2026-03",
    });

    // Transport has never had a budget: absent, with no month to report.
    expect(april.map((b) => b.categoryId)).not.toContain(transport.id);
  });

  it("resolves each category independently", async () => {
    await put(transport.id, "2026-02", 7_500);

    expect(await effective("2026-02", transport.id)).toEqual({
      categoryId: transport.id,
      amountMinor: 7_500,
      effectiveFrom: "2026-02",
    });
    // Food's February answer is unchanged by Transport having one now.
    expect(await effective("2026-02", food.id)).toEqual({
      categoryId: food.id,
      amountMinor: 10_000,
      effectiveFrom: "2026-01",
    });
  });
});

describe("PUT /api/budgets", () => {
  it("upserts on (user, category, month) — the same triple twice is one row", async () => {
    const first = await put(transport.id, "2026-05", 1_000);
    const second = await put(transport.id, "2026-05", 2_000);

    // Same row, updated: a second insert would be a unique violation, and a
    // second *row* would make the effective answer depend on which one wins.
    expect(second.id).toBe(first.id);
    expect(second.amountMinor).toBe(2_000);
    expect(second.createdAt).toBe(first.createdAt);
    expect(Date.parse(second.updatedAt)).toBeGreaterThanOrEqual(
      Date.parse(first.updatedAt),
    );

    expect(await effective("2026-05", transport.id)).toEqual({
      categoryId: transport.id,
      amountMinor: 2_000,
      effectiveFrom: "2026-05",
    });
  });

  it("returns the month as YYYY-MM, not the underlying DATE", async () => {
    const budget = await put(food.id, "2026-07", 33_300);
    expect(budget.month).toBe("2026-07");
    expect(budget.currency).toBe("LKR");
    expect(budget.categoryId).toBe(food.id);
  });

  it("accepts a zero budget — it is a real answer, not a clear", async () => {
    // CHECK (amount_minor >= 0) allows it, and 0 means "spend nothing here",
    // which is not the same statement as "no budget".
    const budget = await put(transport.id, "2026-08", 0);
    expect(budget.amountMinor).toBe(0);
    expect(await effective("2026-08", transport.id)).toEqual({
      categoryId: transport.id,
      amountMinor: 0,
      effectiveFrom: "2026-08",
    });
  });

  it("401s without a session", async () => {
    const r = await app.inject({
      method: "PUT",
      url: "/api/budgets",
      payload: { categoryId: food.id, month: "2026-03", amountMinor: 1 },
    });
    expect(r.statusCode).toBe(401);
  });

  it("400s on a negative amount, a bad month, or a missing key", async () => {
    const bad = [
      { categoryId: food.id, month: "2026-03", amountMinor: -1 },
      { categoryId: food.id, month: "2026-03", amountMinor: 1.5 },
      { categoryId: food.id, month: "2026-3", amountMinor: 1 },
      { categoryId: "not-a-uuid", month: "2026-03", amountMinor: 1 },
      // `amountMinor` is required precisely because null means something:
      // an absent key would be indistinguishable from "leave it alone".
      { categoryId: food.id, month: "2026-03" },
    ];

    for (const payload of bad) {
      const r = await api.put("/api/budgets", payload);
      expect(r.statusCode, JSON.stringify(payload)).toBe(400);
      expect(r.json().error.code).toBe("validation_failed");
    }
  });

  it("400s on an archived category — visible, but not budgetable", async () => {
    const created = await api.post("/api/categories", { name: "Retired" });
    const retired = created.json().category as CategoryDto;
    expect(
      (await api.patch(`/api/categories/${retired.id}`, { archived: true }))
        .statusCode,
    ).toBe(200);

    const r = await api.put("/api/budgets", {
      categoryId: retired.id,
      month: "2026-03",
      amountMinor: 5_000,
    });

    // 400, not 404: the user can see this category, so hiding it would be a
    // lie. They simply cannot budget for one they have retired.
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("validation_failed");
  });

  /**
   * The same existence-oracle rule Task 8 held for expenses and categories:
   * "someone else's category" and "no such category" are one answer. That the
   * two responses match byte for byte is asserted in `ownership.test.ts`,
   * beside the identical cases for `POST /api/expenses` and the two `PATCH`es.
   */
  it("404s for another user's category and for a category that does not exist", async () => {
    const body = { month: "2026-03", amountMinor: 5_000 };

    for (const categoryId of [theirs.id, NOWHERE_ID]) {
      const r = await api.put("/api/budgets", { ...body, categoryId });
      expect(r.statusCode).toBe(404);
      expect(r.json().error.code).toBe("not_found");
    }
  });

  it("writes nothing when the category is not the caller's", async () => {
    // The 404 above must be a refusal, not a refusal-after-writing.
    const r = await other.get("/api/budgets?month=2026-03");
    expect(r.statusCode).toBe(200);
    expect(r.json().items).toEqual([]);
  });
});

describe("budgets are scoped to the session user", () => {
  it("one user's budgets never appear in another's month", async () => {
    const theirBudget = await other.put("/api/budgets", {
      categoryId: theirs.id,
      month: "2026-01",
      amountMinor: 999_999,
    });
    expect(theirBudget.statusCode).toBe(200);

    const mine = (await api.get("/api/budgets?month=2026-01")).json()
      .items as EffectiveBudgetDto[];
    expect(mine.map((b) => b.categoryId)).not.toContain(theirs.id);
    expect(mine.some((b) => b.amountMinor === 999_999)).toBe(false);
  });

  it("an archived category drops out of the effective list", async () => {
    // Task 12's budget-status reads the same resolution; archived categories
    // are out of the *budgeting* surface even though their past expenses stay
    // in filters and reports.
    const created = await api.post("/api/categories", { name: "Sunset" });
    const sunset = created.json().category as CategoryDto;
    await put(sunset.id, "2026-01", 4_200);
    expect((await effective("2026-02", sunset.id))?.amountMinor).toBe(4_200);

    await api.patch(`/api/categories/${sunset.id}`, { archived: true });
    expect(await effective("2026-02", sunset.id)).toBeUndefined();
  });
});
