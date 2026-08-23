import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser, makeTestApp, signupUser } from "../helpers.js";

/**
 * Task 12, Step 1 — the five report endpoints.
 *
 * Every number asserted here is computed by hand from a small fixed dataset
 * so the tests are a second opinion on the SQL rather than a restatement of
 * it. The dataset lives in `seedFixture` below; the arithmetic it implies is
 * written out next to it.
 *
 * Two rules run through the whole file. Aggregation happens in SQL — the
 * tests cannot see that directly, but the overflow cases can: a sum that was
 * built in JS from JSON numbers would have rounded long before the check that
 * omits it. And the exact-integer ceiling (design/api.md) applies to *every*
 * money field that is a sum: past 2^53 - 1 the field is omitted, never
 * rounded, while counts and ratios — which cannot overflow — still come back.
 */

let app: Awaited<ReturnType<typeof makeTestApp>>["app"];
let stop: (() => Promise<void>) | undefined;

/** The largest integer a JSON number carries exactly; also the per-row cap. */
const CEILING = 9_007_199_254_740_991;

interface ExpenseDto {
  id: string;
  categoryId: string;
  amountMinor: number;
  date: string;
  description: string;
}

interface Actor {
  api: ReturnType<typeof asUser>;
  categoryId: (name: string) => string;
}

/** A fresh user: eight seeded categories, no expenses, no budgets. */
async function actor(label: string): Promise<Actor> {
  const api = asUser(app, await signupUser(app, label));
  const cats = (await api.get("/api/categories")).json().items as {
    id: string;
    name: string;
  }[];
  return {
    api,
    categoryId: (name) => {
      const found = cats.find((c) => c.name === name);
      if (!found) throw new Error(`no seeded category named "${name}"`);
      return found.id;
    },
  };
}

interface SeedRow {
  date: string;
  amountMinor: number;
  category: string;
  description?: string;
}

async function add(a: Actor, row: SeedRow): Promise<ExpenseDto> {
  const r = await a.api.post("/api/expenses", {
    date: row.date,
    amountMinor: row.amountMinor,
    description: row.description ?? `${row.category} on ${row.date}`,
    categoryId: a.categoryId(row.category),
  });
  if (r.statusCode !== 201) {
    throw new Error(`seeding ${row.date} -> ${r.statusCode} ${r.body}`);
  }
  return r.json().expense as ExpenseDto;
}

async function seed(a: Actor, rows: SeedRow[]): Promise<ExpenseDto[]> {
  const created: ExpenseDto[] = [];
  for (const row of rows) created.push(await add(a, row));
  return created;
}

async function putBudget(
  a: Actor,
  category: string,
  month: string,
  amountMinor: number | null,
): Promise<void> {
  const r = await a.api.put("/api/budgets", {
    categoryId: a.categoryId(category),
    month,
    amountMinor,
  });
  if (r.statusCode !== 200) {
    throw new Error(`budget ${category} ${month} -> ${r.statusCode} ${r.body}`);
  }
}

/** A report call that must succeed, returning the parsed body. */
async function report<T>(a: Actor, path: string): Promise<T> {
  const r = await a.api.get(`/api/reports/${path}`);
  if (r.statusCode !== 200) {
    throw new Error(`GET /api/reports/${path} -> ${r.statusCode} ${r.body}`);
  }
  return r.json() as T;
}

/**
 * The fixture: three categories over two months, with a deliberately empty
 * month (2026-02) in the middle of the three-month trend window.
 *
 *   2026-01  Food      1_000 + 2_000 + 3_000 = 6_000   (3 rows)
 *            Transport 4_000                           (1 row)
 *            Rent      10_000                          (1 row)
 *            ------------------------------- 20_000, 5 rows, avg 4_000
 *   2026-02  (nothing)
 *   2026-03  Food      500
 *            Transport 1_500
 *            ------------------------------- 2_000, 2 rows, avg 1_000
 *
 * Shares for January: Food 0.3, Transport 0.2, Rent 0.5.
 */
const FIXTURE: SeedRow[] = [
  { date: "2026-01-05", amountMinor: 1_000, category: "Food" },
  { date: "2026-01-10", amountMinor: 2_000, category: "Food" },
  { date: "2026-01-20", amountMinor: 3_000, category: "Food" },
  { date: "2026-01-15", amountMinor: 4_000, category: "Transport" },
  { date: "2026-01-01", amountMinor: 10_000, category: "Rent" },
  { date: "2026-03-02", amountMinor: 500, category: "Food" },
  { date: "2026-03-09", amountMinor: 1_500, category: "Transport" },
];

const JAN = "from=2026-01-01&to=2026-01-31";
const MAR = "from=2026-03-01&to=2026-03-31";

interface Summary {
  totalMinor?: number;
  count: number;
  avgMinor: number;
  prevPeriodTotalMinor?: number;
  deltaPct: number | null;
}

interface ByCategoryItem {
  categoryId: string;
  totalMinor?: number;
  share: number;
}

interface TrendItem {
  month: string;
  totalMinor?: number;
}

interface BudgetStatusItem {
  categoryId: string;
  budgetMinor: number | null;
  spentMinor?: number;
  remainingMinor?: number | null;
  pct?: number | null;
}

beforeAll(async () => {
  const t = await makeTestApp();
  app = t.app;
  stop = t.stop;
  await app.ready();
}, 120_000);

afterAll(async () => {
  await stop?.();
});

describe("summary", () => {
  let a: Actor;

  beforeAll(async () => {
    a = await actor("reports-summary");
    await seed(a, FIXTURE);
  });

  it("totals, counts and averages the range in SQL", async () => {
    const s = await report<Summary>(a, `summary?${JAN}`);
    expect(s.totalMinor).toBe(20_000);
    expect(s.count).toBe(5);
    expect(s.avgMinor).toBe(4_000);
  });

  it("compares against the immediately preceding period of equal length", async () => {
    // March is 31 days; the 31 days before it are Jan 29 .. Feb 28, which hold
    // nothing in the fixture — so the comparison is against an empty period.
    const march = await report<Summary>(a, `summary?${MAR}`);
    expect(march.totalMinor).toBe(2_000);
    expect(march.prevPeriodTotalMinor).toBe(0);
    expect(march.deltaPct).toBeNull();

    // Jan 16 .. Jan 31 (16 days) vs the 16 days before it, Dec 31 .. Jan 15.
    // Later half: Food 3_000 (Jan 20) = 3_000. Earlier half: Rent 10_000 +
    // Food 1_000 + Food 2_000 + Transport 4_000 = 17_000.
    const late = await report<Summary>(
      a,
      "summary?from=2026-01-16&to=2026-01-31",
    );
    expect(late.totalMinor).toBe(3_000);
    expect(late.prevPeriodTotalMinor).toBe(17_000);
    expect(late.deltaPct).toBeCloseTo((3_000 - 17_000) / 17_000, 10);
  });

  it("returns zeros, not an error, for a range with nothing in it", async () => {
    const s = await report<Summary>(a, "summary?from=2026-02-01&to=2026-02-28");
    // The 28 days before February are Jan 4 .. Jan 31 — which is January
    // minus the Jan 1 rent. Equal length is a day count, not "last month".
    expect(s).toEqual({
      totalMinor: 0,
      count: 0,
      avgMinor: 0,
      prevPeriodTotalMinor: 10_000,
      deltaPct: -1,
    });
  });

  /**
   * `avgMinor` is a statistic, not an amount anything is charged, so it is the
   * one money field allowed a fractional part — and it is computed by Postgres
   * from the rows, not by JavaScript from the total. The ceiling test below is
   * what proves the second half: the average of two rows at the cap is the cap
   * itself, which is representable, while their sum is not. An average derived
   * from the total would have had nothing exact to divide.
   */
  it("avgMinor is a non-integer statistic computed from the rows", async () => {
    const b = await actor("reports-summary-avg");
    await seed(b, [
      { date: "2026-06-01", amountMinor: 1, category: "Food" },
      { date: "2026-06-02", amountMinor: 1, category: "Food" },
      { date: "2026-06-03", amountMinor: 2, category: "Food" },
    ]);
    const s = await report<Summary>(b, "summary?from=2026-06-01&to=2026-06-30");
    expect(s.totalMinor).toBe(4);
    expect(s.avgMinor).toBeCloseTo(4 / 3, 12);
    expect(Number.isInteger(s.avgMinor)).toBe(false);
  });

  /**
   * Overflow enumeration for this endpoint:
   *  - `totalMinor`            sum  -> can overflow -> omitted
   *  - `prevPeriodTotalMinor`  sum  -> can overflow -> omitted
   *  - `count`                 bounded by the row count -> cannot
   *  - `avgMinor`              never exceeds the largest row, which is capped -> cannot
   *  - `deltaPct`              a ratio computed in SQL from the exact sums -> cannot
   */
  it("omits a total past the exact-integer ceiling; count, avg and delta survive", async () => {
    const big = await actor("reports-summary-overflow");
    await seed(big, [
      { date: "2026-01-01", amountMinor: CEILING, category: "Food" },
      { date: "2026-01-02", amountMinor: CEILING, category: "Food" },
      // Previous period (Dec 1 .. Dec 31): one row at the cap, representable.
      { date: "2025-12-15", amountMinor: CEILING, category: "Food" },
    ]);
    const s = await report<Summary>(big, `summary?${JAN}`);
    expect(s.totalMinor).toBeUndefined();
    expect(s.count).toBe(2);
    expect(s.avgMinor).toBe(CEILING);
    expect(s.prevPeriodTotalMinor).toBe(CEILING);
    // (2c - c) / c = 1, computed exactly in SQL.
    expect(s.deltaPct).toBeCloseTo(1, 10);
  }, 60_000);

  it("omits a previous-period total past the ceiling independently", async () => {
    const big = await actor("reports-summary-overflow-prev");
    await seed(big, [
      { date: "2025-12-01", amountMinor: CEILING, category: "Food" },
      { date: "2025-12-02", amountMinor: CEILING, category: "Food" },
      { date: "2026-01-10", amountMinor: 1_000, category: "Food" },
    ]);
    const s = await report<Summary>(big, `summary?${JAN}`);
    expect(s.totalMinor).toBe(1_000);
    expect(s.prevPeriodTotalMinor).toBeUndefined();
    expect(s.count).toBe(1);
    expect(s.deltaPct).toBeCloseTo((1_000 - 2 * CEILING) / (2 * CEILING), 10);
  }, 60_000);
});

describe("by-category", () => {
  let a: Actor;

  beforeAll(async () => {
    a = await actor("reports-by-category");
    await seed(a, FIXTURE);
  });

  it("groups the range by category with each category's share of the total", async () => {
    const { items } = await report<{ items: ByCategoryItem[] }>(
      a,
      `by-category?${JAN}`,
    );
    const byId = new Map(items.map((i) => [i.categoryId, i]));
    expect(byId.get(a.categoryId("Food"))).toEqual({
      categoryId: a.categoryId("Food"),
      totalMinor: 6_000,
      share: 0.3,
    });
    expect(byId.get(a.categoryId("Transport"))?.totalMinor).toBe(4_000);
    expect(byId.get(a.categoryId("Rent"))?.share).toBe(0.5);
    // Categories with no spending in the range are not items.
    expect(items).toHaveLength(3);
  });

  it("orders items by total, largest first", async () => {
    const { items } = await report<{ items: ByCategoryItem[] }>(
      a,
      `by-category?${JAN}`,
    );
    expect(items.map((i) => i.totalMinor)).toEqual([10_000, 6_000, 4_000]);
  });

  it("shares sum to 1 within epsilon", async () => {
    const { items } = await report<{ items: ByCategoryItem[] }>(
      a,
      `by-category?${JAN}`,
    );
    const sum = items.reduce((acc, i) => acc + i.share, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
  });

  /**
   * "Shares sum to 1" cannot hold when nothing was spent: 0/0 is not a share.
   * The decision: a range with no spending has no items at all, so there is
   * nothing to divide and nothing whose shares could fail to sum. This falls
   * out of the schema rather than a guard — `CHECK (amount_minor > 0)` means
   * any category that is grouped has a positive total, so the period total is
   * zero exactly when the item list is empty.
   */
  it("returns no items, rather than dividing by zero, when the period total is zero", async () => {
    const { items } = await report<{ items: ByCategoryItem[] }>(
      a,
      "by-category?from=2026-02-01&to=2026-02-28",
    );
    expect(items).toEqual([]);
  });

  /**
   * Overflow enumeration:
   *  - `totalMinor`  per-category sum -> can overflow -> omitted for that item
   *  - `share`       a ratio computed in SQL from the exact sums -> cannot
   */
  it("omits a category total past the ceiling; its share survives", async () => {
    const big = await actor("reports-by-category-overflow");
    await seed(big, [
      { date: "2026-01-01", amountMinor: CEILING, category: "Food" },
      { date: "2026-01-02", amountMinor: CEILING, category: "Food" },
      { date: "2026-01-03", amountMinor: CEILING, category: "Rent" },
    ]);
    const { items } = await report<{ items: ByCategoryItem[] }>(
      big,
      `by-category?${JAN}`,
    );
    const food = items.find((i) => i.categoryId === big.categoryId("Food"));
    const rent = items.find((i) => i.categoryId === big.categoryId("Rent"));
    expect(food?.totalMinor).toBeUndefined();
    expect(food?.share).toBeCloseTo(2 / 3, 10);
    expect(rent?.totalMinor).toBe(CEILING);
    expect(rent?.share).toBeCloseTo(1 / 3, 10);
  }, 60_000);
});

describe("trend", () => {
  let a: Actor;

  beforeAll(async () => {
    a = await actor("reports-trend");
    await seed(a, FIXTURE);
  });

  it("buckets by calendar month and zero-fills the empty middle month", async () => {
    const { items } = await report<{ items: TrendItem[] }>(
      a,
      "trend?from=2026-01-01&to=2026-03-31",
    );
    expect(items).toEqual([
      { month: "2026-01", totalMinor: 20_000 },
      { month: "2026-02", totalMinor: 0 },
      { month: "2026-03", totalMinor: 2_000 },
    ]);
  });

  it("zero-fills months that have never been touched at either end", async () => {
    const { items } = await report<{ items: TrendItem[] }>(
      a,
      "trend?from=2025-12-01&to=2026-04-30",
    );
    expect(items.map((i) => i.month)).toEqual([
      "2025-12",
      "2026-01",
      "2026-02",
      "2026-03",
      "2026-04",
    ]);
    expect(items[0]?.totalMinor).toBe(0);
    expect(items[4]?.totalMinor).toBe(0);
  });

  it("only counts the days inside the range, even within a partial month", async () => {
    const { items } = await report<{ items: TrendItem[] }>(
      a,
      "trend?from=2026-01-10&to=2026-01-20",
    );
    // Jan 10 (2_000), Jan 15 (4_000), Jan 20 (3_000).
    expect(items).toEqual([{ month: "2026-01", totalMinor: 9_000 }]);
  });

  /**
   * Overflow enumeration:
   *  - `totalMinor`  per-month sum -> can overflow -> omitted for that month
   *  - `month`       a label -> cannot
   */
  it("omits a month total past the ceiling while the month stays in the series", async () => {
    const big = await actor("reports-trend-overflow");
    await seed(big, [
      { date: "2026-01-01", amountMinor: CEILING, category: "Food" },
      { date: "2026-01-02", amountMinor: CEILING, category: "Food" },
      { date: "2026-02-01", amountMinor: 1_000, category: "Food" },
    ]);
    const { items } = await report<{ items: TrendItem[] }>(
      big,
      "trend?from=2026-01-01&to=2026-02-28",
    );
    expect(items).toEqual([
      { month: "2026-01" },
      { month: "2026-02", totalMinor: 1_000 },
    ]);
  }, 60_000);
});

describe("budget-status", () => {
  let a: Actor;

  beforeAll(async () => {
    a = await actor("reports-budget-status");
    await seed(a, FIXTURE);
    await putBudget(a, "Food", "2026-01", 5_000); // spent 6_000 -> over
    await putBudget(a, "Transport", "2026-01", 8_000); // spent 4_000 -> under
    // Rent: spent 10_000, never budgeted.
    // Utilities: budgeted, nothing spent.
    await putBudget(a, "Utilities", "2026-01", 2_000);
  });

  const status = async (actorOf: Actor, month: string) =>
    (
      await report<{ items: BudgetStatusItem[] }>(
        actorOf,
        `budget-status?month=${month}`,
      )
    ).items;

  const itemFor = (items: BudgetStatusItem[], actorOf: Actor, name: string) => {
    const found = items.find((i) => i.categoryId === actorOf.categoryId(name));
    if (!found) throw new Error(`no budget-status item for ${name}`);
    return found;
  };

  it("reports remaining and pct, unclamped past 100%", async () => {
    const items = await status(a, "2026-01");
    expect(itemFor(items, a, "Food")).toEqual({
      categoryId: a.categoryId("Food"),
      budgetMinor: 5_000,
      spentMinor: 6_000,
      remainingMinor: -1_000,
      pct: 1.2,
    });
    expect(itemFor(items, a, "Transport")).toEqual({
      categoryId: a.categoryId("Transport"),
      budgetMinor: 8_000,
      spentMinor: 4_000,
      remainingMinor: 4_000,
      pct: 0.5,
    });
  });

  it("reports an unbudgeted category's spend with null budget, remaining and pct", async () => {
    const items = await status(a, "2026-01");
    expect(itemFor(items, a, "Rent")).toEqual({
      categoryId: a.categoryId("Rent"),
      budgetMinor: null,
      spentMinor: 10_000,
      remainingMinor: null,
      pct: null,
    });
  });

  /**
   * The join is budgets against spend, and it must be an outer one: a category
   * that is budgeted but untouched this month is exactly the row a user wants
   * to see — it is the budget going unspent — and an inner join drops it.
   */
  it("lists a budgeted category with no expenses as spent 0, not absent", async () => {
    const items = await status(a, "2026-01");
    expect(itemFor(items, a, "Utilities")).toEqual({
      categoryId: a.categoryId("Utilities"),
      budgetMinor: 2_000,
      spentMinor: 0,
      remainingMinor: 2_000,
      pct: 0,
    });
  });

  it("lists every active category, even with neither budget nor spend", async () => {
    const items = await status(a, "2026-01");
    const ids = new Set(items.map((i) => i.categoryId));
    for (const name of ["Food", "Transport", "Rent", "Utilities"]) {
      expect(ids.has(a.categoryId(name))).toBe(true);
    }
    // Eight seeded categories, all active.
    expect(items).toHaveLength(8);
  });

  it("applies the budget in effect for the month, not only one set that month", async () => {
    // Nothing set for March; January's budgets carry forward. March spend:
    // Food 500 against 5_000.
    const items = await status(a, "2026-03");
    expect(itemFor(items, a, "Food")).toEqual({
      categoryId: a.categoryId("Food"),
      budgetMinor: 5_000,
      spentMinor: 500,
      remainingMinor: 4_500,
      pct: 0.1,
    });
  });

  it("treats a cleared budget as unbudgeted", async () => {
    const b = await actor("reports-budget-status-cleared");
    await putBudget(b, "Food", "2026-01", 5_000);
    await putBudget(b, "Food", "2026-02", null);
    await seed(b, [{ date: "2026-02-10", amountMinor: 700, category: "Food" }]);
    expect(itemFor(await status(b, "2026-02"), b, "Food")).toEqual({
      categoryId: b.categoryId("Food"),
      budgetMinor: null,
      spentMinor: 700,
      remainingMinor: null,
      pct: null,
    });
  });

  it("a zero budget has no percentage", async () => {
    const b = await actor("reports-budget-status-zero");
    await putBudget(b, "Food", "2026-01", 0);
    await seed(b, [{ date: "2026-01-10", amountMinor: 300, category: "Food" }]);
    expect(itemFor(await status(b, "2026-01"), b, "Food")).toEqual({
      categoryId: b.categoryId("Food"),
      budgetMinor: 0,
      spentMinor: 300,
      remainingMinor: -300,
      pct: null,
    });
  });

  /**
   * Overflow enumeration:
   *  - `budgetMinor`     a single stored row, capped by the wire schema -> cannot
   *  - `spentMinor`      per-category sum -> can overflow -> omitted
   *  - `remainingMinor`  budget - spent: bounded on both sides only while
   *                      `spent` is; omitted together with it
   *  - `pct`             spent / budget: same inputs, omitted together with it
   */
  it("omits spent, remaining and pct past the ceiling; the budget stays", async () => {
    const big = await actor("reports-budget-status-overflow");
    await putBudget(big, "Food", "2026-01", 5_000);
    await seed(big, [
      { date: "2026-01-01", amountMinor: CEILING, category: "Food" },
      { date: "2026-01-02", amountMinor: CEILING, category: "Food" },
    ]);
    expect(itemFor(await status(big, "2026-01"), big, "Food")).toEqual({
      categoryId: big.categoryId("Food"),
      budgetMinor: 5_000,
    });
  }, 60_000);

  it("rejects a malformed month", async () => {
    const r = await a.api.get("/api/reports/budget-status?month=2026-1");
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe("validation_failed");
  });
});

describe("top-expenses", () => {
  let a: Actor;
  let created: ExpenseDto[];

  beforeAll(async () => {
    a = await actor("reports-top");
    created = await seed(a, FIXTURE);
  });

  it("defaults to the five largest in the range, largest first", async () => {
    const { items } = await report<{ items: ExpenseDto[] }>(
      a,
      "top-expenses?from=2026-01-01&to=2026-03-31",
    );
    expect(items.map((i) => i.amountMinor)).toEqual([
      10_000, 4_000, 3_000, 2_000, 1_500,
    ]);
    // Full expense DTOs, not a projection.
    expect(items[0]?.id).toBe(created[4]?.id);
    expect(items[0]?.description).toBe("Rent on 2026-01-01");
  });

  it("honours limit and the range bounds", async () => {
    const { items } = await report<{ items: ExpenseDto[] }>(
      a,
      `top-expenses?${MAR}&limit=1`,
    );
    expect(items.map((i) => i.amountMinor)).toEqual([1_500]);
  });

  it("caps limit at 20", async () => {
    const r = await a.api.get(`/api/reports/top-expenses?${JAN}&limit=21`);
    expect(r.statusCode).toBe(400);
  });
});

describe("range validation and auth", () => {
  let a: Actor;

  beforeAll(async () => {
    a = await actor("reports-validation");
  });

  it.each(["summary", "by-category", "trend", "top-expenses"])(
    "%s: from > to is a 400 envelope",
    async (path) => {
      const r = await a.api.get(
        `/api/reports/${path}?from=2026-02-01&to=2026-01-31`,
      );
      expect(r.statusCode).toBe(400);
      expect(r.json().error.code).toBe("validation_failed");
    },
  );

  it.each(["summary", "by-category", "trend", "top-expenses"])(
    "%s: a span over five years is a 400 envelope",
    async (path) => {
      const r = await a.api.get(
        `/api/reports/${path}?from=2021-01-01&to=2026-01-02`,
      );
      expect(r.statusCode).toBe(400);
      expect(r.json().error.code).toBe("validation_failed");
    },
  );

  it.each([
    "summary?from=2026-01-01&to=2026-01-31",
    "by-category?from=2026-01-01&to=2026-01-31",
    "trend?from=2026-01-01&to=2026-01-31",
    "budget-status?month=2026-01",
    "top-expenses?from=2026-01-01&to=2026-01-31",
  ])("%s: unauthenticated is 401", async (path) => {
    const r = await app.inject({ method: "GET", url: `/api/reports/${path}` });
    expect(r.statusCode).toBe(401);
    expect(r.json().error.code).toBe("unauthorized");
  });

  it("scopes every report to the caller — another user's spending is invisible", async () => {
    const spender = await actor("reports-isolation-spender");
    await seed(spender, FIXTURE);
    const s = await report<Summary>(a, `summary?${JAN}`);
    expect(s.count).toBe(0);
    expect(s.totalMinor).toBe(0);
    const { items } = await report<{ items: ByCategoryItem[] }>(
      a,
      `by-category?${JAN}`,
    );
    expect(items).toEqual([]);
  });
});
