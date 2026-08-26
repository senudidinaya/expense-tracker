import { describe, expect, it } from "vitest";
import { firstOccurrenceOnOrAfter } from "../../src/domain/recurring.js";
import { addDays, daysBetween } from "../../src/lib/dates.js";
import { expectOnOrBefore, expectStrictlyBefore } from "../helpers.js";
import { demoDataset } from "../../src/seed/demo-data.js";

/**
 * Task 15, Step 1 — the demo dataset, as a pure function.
 *
 * ## Two parameters, no clock
 *
 * `demoDataset(today, seed)`. `today` is injected exactly as it is for the
 * recurring generator (Task 14): nothing in here reads the clock, so a suite
 * pinned to fixed dates stays green in any month and the awkward calendar
 * cases can be asserted rather than approximated.
 *
 * `seed` is the **new user's id**, not a fixed constant. This differs from
 * design/plan.md, which said "jitter seeded from a fixed PRNG", and was
 * changed in review: a fixed seed makes every demo visitor's screenshot
 * identical, and two reviewers comparing notes see the same numbers. Seeding
 * from the user id keeps the function pure and deterministic — the same user
 * always gets the same dataset, so a reload never reshuffles the data — while
 * two demo users provisioned the same day get different amounts.
 *
 * ## What this file may and may not assert
 *
 * The dataset's SHAPE is fixed: the same categories, the same recurring rules,
 * the same budgeted categories, the same rough cadence. Only the VALUES vary
 * with the seed.
 *
 * So every assertion here is a range or a structural fact. An assertion like
 * `expect(groceries).toBe(12_000_00)` would only pass under a fixed seed and
 * is forbidden — it would pin the one thing the review decision made vary,
 * and it would go green again the moment someone reverted the seed to a
 * constant.
 *
 * ## The uuidv7 prefix trap
 *
 * `seed` is a uuidv7, which is time-ordered: two demo users provisioned
 * seconds apart share a long leading prefix. A PRNG seeded from
 * `parseInt(seed.slice(0, 8), 16)` therefore hands those two users the
 * *identical* dataset while passing any test that compares two randomly
 * chosen uuids. The seeds below differ only in their final character, which
 * is the case that catches it.
 *
 * ## Why every `demoDataset` call sits inside an `it`
 *
 * Hoisting one call to a `describe` body would run it at collection time,
 * where a throw takes the whole file down as a failed *suite* — vitest
 * reports "no tests" and not one assertion below gets to say what it wanted.
 * `sample()` is the deferred form; it is called, never captured.
 */

/**
 * design/api.md fixes this seed set (repos/categories.ts spells the same list).
 * It is written out here rather than imported so the test states the
 * requirement independently — importing the constant would make the assertion
 * agree with whatever the code happens to say.
 */
const DEFAULT_CATEGORY_NAMES = [
  "Food",
  "Transport",
  "Rent",
  "Utilities",
  "Health",
  "Entertainment",
  "Shopping",
  "Other",
];

/** An ordinary mid-month day; the awkward ones get their own describe below. */
const TODAY = "2026-08-26";

/**
 * Two uuidv7s from the same millisecond: identical but for the last nibble.
 * See "the uuidv7 prefix trap" above.
 */
const SEED_A = "0198f3b2-4c1a-7c3e-9f21-6d5a8b7c0d11";
const SEED_B = "0198f3b2-4c1a-7c3e-9f21-6d5a8b7c0d12";

type Dataset = ReturnType<typeof demoDataset>;

/** The default dataset, built inside whichever test asked for it. */
const sample = (today = TODAY, seed = SEED_A): Dataset =>
  demoDataset(today, seed);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` that names a day that exists — "2026-02-30" fails this. */
const isRealDate = (s: string): boolean =>
  ISO_DATE.test(s) &&
  new Date(`${s}T00:00:00.000Z`).toISOString().slice(0, 10) === s;

/** The first of `date`'s month, which is the form `budgets.month_start` takes. */
const monthStartOf = (date: string): string => `${date.slice(0, 7)}-01`;

/** Every money value in the dataset, whatever table it is destined for. */
const allAmounts = (d: Dataset): number[] => [
  ...d.expenses.map((e) => e.amountMinor),
  ...d.budgets.map((b) => b.amountMinor),
  ...d.recurringRules.map((r) => r.amountMinor),
];

/** Every date in the dataset, in any field. */
const allDates = (d: Dataset): string[] => [
  ...d.expenses.map((e) => e.date),
  ...d.budgets.map((b) => b.monthStart),
  ...d.recurringRules.flatMap((r) => [
    r.startDate,
    r.nextOccurrence,
    ...(r.endDate == null ? [] : [r.endDate]),
  ]),
];

/** Every category name the dataset refers to, from any of its lists. */
const categoriesReferenced = (d: Dataset): string[] =>
  [
    ...new Set([
      ...d.expenses.map((e) => e.category),
      ...d.budgets.map((b) => b.category),
      ...d.recurringRules.map((r) => r.category),
    ]),
  ].sort();

/** Expense dates, ascending. */
const expenseDates = (d: Dataset): string[] =>
  d.expenses.map((e) => e.date).sort();

/**
 * Everything that must NOT move when the seed changes. Amounts are excluded by
 * construction — they are the whole of what the seed is allowed to vary.
 */
const shapeOf = (d: Dataset) => ({
  categories: [...d.categories].sort(),
  expenseCategories: [...new Set(d.expenses.map((e) => e.category))].sort(),
  budgetSlots: d.budgets.map((b) => `${b.category}@${b.monthStart}`).sort(),
  rules: d.recurringRules
    .map((r) =>
      [
        r.category,
        r.description,
        r.frequency,
        r.startDate,
        r.endDate ?? "",
        r.nextOccurrence,
      ].join("|"),
    )
    .sort(),
});

// ---------------------------------------------------------------------------

describe("determinism", () => {
  it("is a pure function of (today, seed)", () => {
    expect(sample()).toEqual(sample());
  });

  it("gives one user the same amounts on every call", () => {
    // A demo visitor who reloads must not see the numbers reshuffle; the id is
    // the only entropy, so the same id is the same dataset.
    expect(allAmounts(sample())).toEqual(allAmounts(sample()));
  });
});

describe("the seed varies the values", () => {
  it("two ids differing only in their last character get different amounts", () => {
    // Not "some amount differs" by luck: under a fixed seed, or a PRNG seeded
    // from the uuidv7 time prefix, these two arrays are identical.
    expect(allAmounts(sample(TODAY, SEED_B))).not.toEqual(
      allAmounts(sample(TODAY, SEED_A)),
    );
  });

  it("varies the expense amounts specifically, not one derived total", () => {
    const amounts = (seed: string) =>
      sample(TODAY, seed).expenses.map((e) => e.amountMinor);
    expect(amounts(SEED_B)).not.toEqual(amounts(SEED_A));
  });
});

describe("the shape is fixed across seeds", () => {
  it("same categories, same rules, same budget slots", () => {
    expect(shapeOf(sample(TODAY, SEED_B))).toEqual(
      shapeOf(sample(TODAY, SEED_A)),
    );
  });

  it("gives every seed the identical number of expenses", () => {
    // Tightened from "within 25%", which could not fail: counts are fixed, so
    // the difference was always exactly 0 and the assertion had nothing to
    // catch. Exact equality is what the implementation actually promises, and
    // it goes red the moment counts become seeded.
    //
    // They are fixed on purpose (see seed/demo-data.ts): drawn per category
    // per month, a seeded count has a long enough tail that two visitors on
    // the same day could land 40% apart — one seeing six months of data, the
    // next seeing a sparse one. Cadence is part of the shape; jitter belongs
    // in the amounts. That is a decision, so changing it should cost a test.
    expect(sample(TODAY, SEED_B).expenses.length).toBe(
      sample(TODAY, SEED_A).expenses.length,
    );
  });
});

describe("the window: about six months, ending today", () => {
  it("dates nothing after today", () => {
    // The wire schema tolerates a year ahead; a demo's *history* must not use
    // it, or the dashboard opens on a current month with rows beyond it.
    expectOnOrBefore(expenseDates(sample()).at(-1)!, TODAY);
  });

  it("runs right up to today — the last expense is within the past week", () => {
    expectOnOrBefore(addDays(TODAY, -7), expenseDates(sample()).at(-1)!);
  });

  it("reaches back roughly six months", () => {
    const span = daysBetween(expenseDates(sample())[0]!, TODAY);
    expect(span).toBeGreaterThanOrEqual(150);
    expect(span).toBeLessThanOrEqual(210);
  });

  it("emits only real calendar dates, in YYYY-MM-DD", () => {
    for (const date of allDates(sample())) {
      expect(isRealDate(date)).toBe(true);
    }
  });

  it("tracks the injected `today` rather than the clock", () => {
    const lastOf = (today: string) => expenseDates(sample(today)).at(-1)!;
    expectStrictlyBefore(lastOf("2026-03-15"), "2026-03-16");
    expectStrictlyBefore("2026-08-01", lastOf(TODAY));
  });
});

describe("money", () => {
  it("is positive integer minor units everywhere", () => {
    for (const amount of allAmounts(sample())) {
      expect(Number.isInteger(amount)).toBe(true);
      expect(amount).toBeGreaterThan(0);
      expect(amount).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
    }
  });

  it("keeps every expense in a plausible LKR band", () => {
    // Rs 1.00 to Rs 500,000.00. A dataset that had quietly slipped into major
    // units would put a Rs 85,000 rent through here as 85_000 minor — Rs 850.
    for (const { amountMinor } of sample().expenses) {
      expect(amountMinor).toBeGreaterThanOrEqual(1_00);
      expect(amountMinor).toBeLessThanOrEqual(500_000_00);
    }
  });

  it("puts the monthly Rent rule near the going rate, not exactly on it", () => {
    // design/plan.md's figure is 85,000_00. The seed moves it, so this is a
    // band around that figure — the exact value is the seed's business.
    const rent = sample().recurringRules.filter(
      (r) => r.category === "Rent" && r.frequency === "monthly",
    );
    expect(rent).toHaveLength(1);
    expect(rent[0]!.amountMinor).toBeGreaterThanOrEqual(50_000_00);
    expect(rent[0]!.amountMinor).toBeLessThanOrEqual(120_000_00);
  });

  it("keeps Food spending weekly and in a groceries band", () => {
    const food = sample().expenses.filter((e) => e.category === "Food");
    expect(food.length).toBeGreaterThanOrEqual(20); // ~weekly over six months
    for (const { amountMinor } of food) {
      expect(amountMinor).toBeGreaterThanOrEqual(2_000_00);
      expect(amountMinor).toBeLessThanOrEqual(30_000_00);
    }
  });
});

describe("categories", () => {
  it("names only the eight seeded defaults", () => {
    // The route seeds the default categories and then maps these names onto
    // their ids. A name outside the set has no id to map to.
    for (const name of categoriesReferenced(sample())) {
      expect(DEFAULT_CATEGORY_NAMES).toContain(name);
    }
  });

  it("declares exactly the categories it uses — none unused, none missing", () => {
    const dataset = sample();
    expect([...dataset.categories].sort()).toEqual(
      categoriesReferenced(dataset),
    );
  });

  it("spreads across at least five categories", () => {
    expect(sample().categories.length).toBeGreaterThanOrEqual(5);
  });
});

describe("expenses", () => {
  it("carries a description within the column's 1..200 CHECK", () => {
    for (const { description } of sample().expenses) {
      expect(description.trim().length).toBeGreaterThanOrEqual(1);
      expect(description.length).toBeLessThanOrEqual(200);
    }
  });

  it("carries notes that are absent, null, or within the 2000 CHECK", () => {
    for (const { notes } of sample().expenses) {
      if (notes != null) expect(notes.length).toBeLessThanOrEqual(2000);
    }
  });
});

describe("budgets", () => {
  it("budgets exactly five categories", () => {
    expect(new Set(sample().budgets.map((b) => b.category)).size).toBe(5);
  });

  it("starts every budget on the first of a month", () => {
    // budgets_month_start_check: extract(day from month_start) = 1.
    for (const { monthStart } of sample().budgets) {
      expect(monthStart).toBe(monthStartOf(monthStart));
    }
  });

  it("never repeats a (category, month) slot", () => {
    // budgets_user_cat_month_uq — a repeat is an insert that fails the whole
    // transaction, so it has to be impossible before it reaches Postgres.
    const slots = sample().budgets.map((b) => `${b.category}@${b.monthStart}`);
    expect(new Set(slots).size).toBe(slots.length);
  });

  it("leaves every budgeted category with a budget in effect today", () => {
    // design/schema.md: the effective budget for month M is the row with the
    // greatest month_start <= M. Rows sitting in the window's past are fine;
    // rows starting next month show a demo dashboard with no budget bars.
    const { budgets } = sample();
    const currentMonth = monthStartOf(TODAY);

    for (const category of new Set(budgets.map((b) => b.category))) {
      const effective = budgets
        .filter((b) => b.category === category && b.monthStart <= currentMonth)
        .sort((x, y) => x.monthStart.localeCompare(y.monthStart))
        .at(-1);
      expect(effective).toBeDefined();
      expect(effective!.amountMinor).toBeGreaterThan(0);
    }
  });
});

describe("recurring rules", () => {
  it("creates two or three", () => {
    expect(sample().recurringRules.length).toBeGreaterThanOrEqual(2);
    expect(sample().recurringRules.length).toBeLessThanOrEqual(3);
  });

  it("uses only the two supported frequencies", () => {
    for (const { frequency } of sample().recurringRules) {
      expect(["weekly", "monthly"]).toContain(frequency);
    }
  });

  it("anchors every rule inside the window, ending no earlier than it starts", () => {
    for (const rule of sample().recurringRules) {
      expectOnOrBefore(rule.startDate, TODAY);
      expect(daysBetween(rule.startDate, TODAY)).toBeLessThanOrEqual(210);
      // recurring_rules_end_date_check.
      if (rule.endDate != null) {
        expectOnOrBefore(rule.startDate, rule.endDate);
      }
    }
  });

  it("hands the nightly generator a cursor that is strictly in the future", () => {
    // The dataset writes its own history. A cursor at or before `today` makes
    // the first nightly run generate an occurrence for a day the seed already
    // covered — a duplicate `expenses_rule_date_uq` cannot catch, because
    // seeded expenses carry no recurring_rule_id.
    for (const { nextOccurrence } of sample().recurringRules) {
      expectStrictlyBefore(TODAY, nextOccurrence);
    }
  });

  it("puts that cursor on the rule's own anchor grid", () => {
    // Not merely "some future date": the generator derives every subsequent
    // occurrence from start_date's anchor, so a cursor off the grid makes the
    // demo's first generated expense land on a day the schedule never names.
    for (const rule of sample().recurringRules) {
      expect(rule.nextOccurrence).toBe(
        firstOccurrenceOnOrAfter(rule, addDays(TODAY, 1)),
      );
    }
  });
});

describe("awkward calendars", () => {
  // `today` is injected precisely so these are assertions rather than a wait
  // for the 31st. Each is a day where clamping, a leap year, or a year
  // boundary could produce an impossible date or a cursor off the anchor grid.
  for (const today of [
    "2026-01-31", // anchor 31, next month is 28 days
    "2026-02-28", // end of a short month
    "2028-02-29", // leap day
    "2026-12-31", // year boundary
    "2026-03-01", // first of a month; the window opens in the previous year
  ]) {
    it(`produces a coherent dataset for today = ${today}`, () => {
      const dataset = sample(today);

      for (const date of allDates(dataset)) {
        expect(isRealDate(date)).toBe(true);
      }
      for (const { date } of dataset.expenses) {
        expectOnOrBefore(date, today);
      }
      for (const rule of dataset.recurringRules) {
        expect(rule.nextOccurrence).toBe(
          firstOccurrenceOnOrAfter(rule, addDays(today, 1)),
        );
      }
      for (const { monthStart } of dataset.budgets) {
        expect(monthStart).toBe(monthStartOf(monthStart));
        expectOnOrBefore(monthStart, monthStartOf(today));
      }
    });
  }
});
