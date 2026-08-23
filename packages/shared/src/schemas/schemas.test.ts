import { describe, it, expect } from "vitest";
import {
  amountMinor,
  budgetDto,
  budgetPutBody,
  budgetsGetQuery,
  budgetsGetResponse,
  byCategoryResponse,
  budgetStatusResponse,
  categoryDto,
  createCategoryBody,
  createExpenseBody,
  createRecurringBody,
  expenseDate,
  expenseDto,
  isoDate,
  isoMonth,
  exportExpensesQuery,
  listExpensesQuery,
  listExpensesResponse,
  loginBody,
  moneyMinor,
  patchCategoryBody,
  patchExpenseBody,
  patchRecurringBody,
  plusOneYear,
  recurringRuleDto,
  reportRangeQuery,
  signupBody,
  summaryResponse,
  todayIsoDate,
  topExpensesQuery,
  trendResponse,
  userDto,
} from "../index.js";
import type { User } from "../index.js";

// Fixed UUIDv7 literals — deterministic, and no dependency on crypto typings.
const CATEGORY_ID = "0192f0c8-8d3a-7c9e-9b1a-6f6f4a2b1c3d";
const EXPENSE_ID = "0192f0c8-8d3a-7c9e-9b1a-6f6f4a2b1c3e";
const RULE_ID = "0192f0c8-8d3a-7c9e-9b1a-6f6f4a2b1c3f";
const USER_ID = "0192f0c8-8d3a-7c9e-9b1a-6f6f4a2b1c40";
const NOW = "2026-01-05T10:15:00.000Z";

describe("isoDate", () => {
  it("accepts a real calendar date", () => {
    expect(isoDate.parse("2026-01-05")).toBe("2026-01-05");
  });

  it("accepts Feb 29 in a leap year", () => {
    expect(isoDate.safeParse("2024-02-29").success).toBe(true);
  });

  // The rule the whole date contract rests on: a regex alone would pass this.
  it("rejects 2025-02-31 — a well-formed string that is not a real date", () => {
    expect(isoDate.safeParse("2025-02-31").success).toBe(false);
  });

  it("rejects Feb 29 in a non-leap year", () => {
    expect(isoDate.safeParse("2025-02-29").success).toBe(false);
  });

  it("rejects month 13", () => {
    expect(isoDate.safeParse("2025-13-01").success).toBe(false);
  });

  it("rejects an unpadded date", () => {
    expect(isoDate.safeParse("2025-1-05").success).toBe(false);
  });

  it("rejects a datetime", () => {
    expect(isoDate.safeParse("2025-01-05T00:00:00Z").success).toBe(false);
  });
});

describe("isoMonth", () => {
  it("accepts YYYY-MM", () => {
    expect(isoMonth.parse("2026-08")).toBe("2026-08");
  });

  it("rejects month 13", () => {
    expect(isoMonth.safeParse("2026-13").success).toBe(false);
  });

  it("rejects month 00", () => {
    expect(isoMonth.safeParse("2026-00").success).toBe(false);
  });

  it("rejects a full date", () => {
    expect(isoMonth.safeParse("2026-08-01").success).toBe(false);
  });
});

describe("money", () => {
  it("accepts zero and positive integers as minor units", () => {
    expect(moneyMinor.parse(0)).toBe(0);
    expect(moneyMinor.parse(125000)).toBe(125000);
  });

  // The reason money is minor units at every boundary.
  it("rejects 12.34 — decimals never cross the wire", () => {
    expect(moneyMinor.safeParse(12.34).success).toBe(false);
    expect(amountMinor.safeParse(12.34).success).toBe(false);
  });

  it("rejects negatives", () => {
    expect(moneyMinor.safeParse(-1).success).toBe(false);
  });

  it("rejects amounts beyond the 2^53 safe-integer ceiling", () => {
    expect(moneyMinor.safeParse(Number.MAX_SAFE_INTEGER).success).toBe(true);
    expect(moneyMinor.safeParse(Number.MAX_SAFE_INTEGER + 1).success).toBe(
      false,
    );
  });

  it("rejects NaN and Infinity", () => {
    expect(moneyMinor.safeParse(Number.NaN).success).toBe(false);
    expect(moneyMinor.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
  });

  it("amountMinor rejects zero — an expense of nothing is not an expense", () => {
    expect(amountMinor.parse(1)).toBe(1);
    expect(amountMinor.safeParse(0).success).toBe(false);
  });

  it("rejects a decimal string", () => {
    expect(moneyMinor.safeParse("1234").success).toBe(false);
  });
});

describe("todayIsoDate / plusOneYear / expenseDate", () => {
  it("adds a calendar year", () => {
    expect(plusOneYear(new Date(Date.UTC(2026, 0, 5)))).toBe("2027-01-05");
  });

  it("normalizes Feb 29 to Mar 1 in the following year", () => {
    expect(plusOneYear(new Date(Date.UTC(2028, 1, 29)))).toBe("2029-03-01");
  });

  // These schemas run in the browser and on the server. If the day boundary were
  // read from local components, the same instant would be a different date in
  // Colombo (+05:30) than in UTC, and the two sides would disagree on whether a
  // date is more than a year ahead.
  it("reads the day boundary in UTC, not local time", () => {
    // 23:30Z is already the next day in Colombo, and the previous day in Honolulu.
    expect(todayIsoDate(new Date("2026-01-05T23:30:00.000Z"))).toBe(
      "2026-01-05",
    );
    expect(todayIsoDate(new Date("2026-01-05T00:30:00.000Z"))).toBe(
      "2026-01-05",
    );
    expect(plusOneYear(new Date("2026-01-05T23:30:00.000Z"))).toBe(
      "2027-01-05",
    );
  });

  it("accepts a date exactly one year ahead", () => {
    expect(expenseDate.safeParse(plusOneYear()).success).toBe(true);
  });

  it("accepts a past date", () => {
    expect(expenseDate.safeParse("2020-03-01").success).toBe(true);
  });

  it("rejects a date more than one year ahead", () => {
    expect(expenseDate.safeParse("2099-01-01").success).toBe(false);
  });

  it("still rejects impossible calendar dates", () => {
    expect(expenseDate.safeParse("2025-02-31").success).toBe(false);
  });
});

describe("signupBody / loginBody", () => {
  it("accepts a valid signup", () => {
    expect(
      signupBody.parse({ email: "a@b.co", password: "correct-horse" }),
    ).toEqual({
      email: "a@b.co",
      password: "correct-horse",
    });
  });

  it("rejects a malformed email", () => {
    expect(
      signupBody.safeParse({ email: "not-an-email", password: "correct-horse" })
        .success,
    ).toBe(false);
  });

  it("rejects an email longer than 254 chars", () => {
    const long = `${"a".repeat(250)}@b.co`;
    expect(
      signupBody.safeParse({ email: long, password: "correct-horse" }).success,
    ).toBe(false);
  });

  it("rejects a password shorter than 8", () => {
    expect(
      signupBody.safeParse({ email: "a@b.co", password: "short" }).success,
    ).toBe(false);
  });

  it("rejects a password longer than 128", () => {
    expect(
      signupBody.safeParse({ email: "a@b.co", password: "x".repeat(129) })
        .success,
    ).toBe(false);
  });

  it("accepts any non-empty password on login — length rules are a signup concern", () => {
    expect(
      loginBody.safeParse({ email: "a@b.co", password: "short" }).success,
    ).toBe(true);
    expect(loginBody.safeParse({ email: "a@b.co", password: "" }).success).toBe(
      false,
    );
  });
});

describe("userDto", () => {
  const row = {
    id: USER_ID,
    email: "a@b.co",
    isDemo: false,
    createdAt: NOW,
    passwordHash: "$argon2id$v=19$m=65536,t=3,p=4$abc$def",
  };

  it("parses a user", () => {
    const parsed = userDto.parse(row);
    expect(parsed.id).toBe(USER_ID);
    expect(parsed.email).toBe("a@b.co");
    expect(parsed.isDemo).toBe(false);
  });

  // The invariant: the hash never leaves the repository layer.
  it("has no passwordHash — the key is dropped, not carried through", () => {
    const parsed = userDto.parse(row);
    expect(parsed).not.toHaveProperty("passwordHash");
    expect(Object.keys(parsed)).toEqual(["id", "email", "isDemo", "createdAt"]);
  });

  it("has no passwordHash in the inferred type, not even as optional", () => {
    // Compile-time half of the assertion above: `keyof User` must not include
    // "passwordHash" at all — an optional `passwordHash?: string` would fail here.
    const noHash: "passwordHash" extends keyof User ? never : true = true;
    expect(noHash).toBe(true);
  });

  it("rejects a missing createdAt", () => {
    expect(
      userDto.safeParse({ id: USER_ID, email: "a@b.co", isDemo: false })
        .success,
    ).toBe(false);
  });

  it("rejects a non-ISO createdAt", () => {
    expect(userDto.safeParse({ ...row, createdAt: "yesterday" }).success).toBe(
      false,
    );
  });
});

describe("category schemas", () => {
  it("accepts a category name", () => {
    expect(createCategoryBody.parse({ name: "Food" })).toEqual({
      name: "Food",
    });
  });

  it("rejects an empty name", () => {
    expect(createCategoryBody.safeParse({ name: "" }).success).toBe(false);
  });

  it("rejects a name longer than 50", () => {
    expect(createCategoryBody.safeParse({ name: "x".repeat(51) }).success).toBe(
      false,
    );
  });

  it("patch takes name and archived, both optional", () => {
    expect(patchCategoryBody.parse({})).toEqual({});
    expect(patchCategoryBody.parse({ archived: true })).toEqual({
      archived: true,
    });
    expect(patchCategoryBody.parse({ name: "Travel" })).toEqual({
      name: "Travel",
    });
  });

  it("patch rejects a non-boolean archived", () => {
    expect(patchCategoryBody.safeParse({ archived: "yes" }).success).toBe(
      false,
    );
  });

  it("categoryDto carries archivedAt as a nullable timestamp", () => {
    const parsed = categoryDto.parse({
      id: CATEGORY_ID,
      name: "Food",
      archivedAt: null,
      createdAt: NOW,
    });
    expect(parsed.archivedAt).toBeNull();
    expect(
      categoryDto.safeParse({ id: CATEGORY_ID, name: "Food", createdAt: NOW })
        .success,
    ).toBe(false);
  });
});

describe("expense schemas", () => {
  const valid = {
    amountMinor: 125000,
    categoryId: CATEGORY_ID,
    date: "2026-01-05",
    description: "Lunch",
  };

  it("accepts a create body", () => {
    expect(createExpenseBody.parse(valid)).toEqual(valid);
  });

  it("rejects a non-integer amount", () => {
    expect(
      createExpenseBody.safeParse({ ...valid, amountMinor: 10.5 }).success,
    ).toBe(false);
  });

  it("rejects a zero amount", () => {
    expect(
      createExpenseBody.safeParse({ ...valid, amountMinor: 0 }).success,
    ).toBe(false);
  });

  it("rejects a non-uuid categoryId", () => {
    expect(
      createExpenseBody.safeParse({ ...valid, categoryId: "nope" }).success,
    ).toBe(false);
  });

  it("rejects an impossible date", () => {
    expect(
      createExpenseBody.safeParse({ ...valid, date: "2025-02-31" }).success,
    ).toBe(false);
  });

  it("rejects a date more than a year ahead", () => {
    expect(
      createExpenseBody.safeParse({ ...valid, date: "2099-01-01" }).success,
    ).toBe(false);
    expect(
      createExpenseBody.safeParse({ ...valid, date: plusOneYear() }).success,
    ).toBe(true);
  });

  it("rejects an empty description and one over 200 chars", () => {
    expect(
      createExpenseBody.safeParse({ ...valid, description: "" }).success,
    ).toBe(false);
    expect(
      createExpenseBody.safeParse({ ...valid, description: "x".repeat(201) })
        .success,
    ).toBe(false);
  });

  it("accepts optional notes up to 2000 chars", () => {
    expect(
      createExpenseBody.safeParse({ ...valid, notes: "x".repeat(2000) })
        .success,
    ).toBe(true);
    expect(
      createExpenseBody.safeParse({ ...valid, notes: "x".repeat(2001) })
        .success,
    ).toBe(false);
  });

  it("carries no server-derived fields — id, userId and timestamps are rejected as unknown", () => {
    const parsed = createExpenseBody.parse({
      ...valid,
      id: EXPENSE_ID,
      userId: USER_ID,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(parsed).toEqual(valid);
  });

  it("patch is fully partial and takes no id", () => {
    expect(patchExpenseBody.parse({})).toEqual({});
    expect(patchExpenseBody.parse({ amountMinor: 500 })).toEqual({
      amountMinor: 500,
    });
    expect(
      patchExpenseBody.parse({ id: EXPENSE_ID, amountMinor: 500 }),
    ).toEqual({
      amountMinor: 500,
    });
  });

  it("patch still enforces every rule on the fields it does carry", () => {
    expect(patchExpenseBody.safeParse({ amountMinor: 10.5 }).success).toBe(
      false,
    );
    expect(patchExpenseBody.safeParse({ date: "2025-02-31" }).success).toBe(
      false,
    );
  });

  it("parses an expense dto", () => {
    const row = {
      id: EXPENSE_ID,
      categoryId: CATEGORY_ID,
      recurringRuleId: null,
      amountMinor: 125000,
      currency: "LKR",
      date: "2026-01-05",
      description: "Lunch",
      notes: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(expenseDto.parse(row)).toEqual(row);
    expect(expenseDto.safeParse({ ...row, currency: "USD" }).success).toBe(
      false,
    );
  });

  it("dto rejects a leaked userId only by stripping it", () => {
    const parsed = expenseDto.parse({
      id: EXPENSE_ID,
      categoryId: CATEGORY_ID,
      recurringRuleId: RULE_ID,
      amountMinor: 1,
      currency: "LKR",
      date: "2026-01-05",
      description: "Lunch",
      notes: "n",
      createdAt: NOW,
      updatedAt: NOW,
      userId: USER_ID,
    });
    expect(parsed).not.toHaveProperty("userId");
  });
});

describe("listExpensesQuery", () => {
  it("defaults limit to 50", () => {
    expect(listExpensesQuery.parse({}).limit).toBe(50);
  });

  it("coerces limit from a query string and caps it at 100", () => {
    expect(listExpensesQuery.parse({ limit: "100" }).limit).toBe(100);
    expect(listExpensesQuery.safeParse({ limit: "101" }).success).toBe(false);
    expect(listExpensesQuery.safeParse({ limit: "0" }).success).toBe(false);
  });

  it("caps q at 100 chars", () => {
    expect(listExpensesQuery.safeParse({ q: "a".repeat(100) }).success).toBe(
      true,
    );
    expect(listExpensesQuery.safeParse({ q: "a".repeat(101) }).success).toBe(
      false,
    );
  });

  it("splits categoryIds on commas", () => {
    expect(
      listExpensesQuery.parse({ categoryIds: `${CATEGORY_ID},${RULE_ID}` })
        .categoryIds,
    ).toEqual([CATEGORY_ID, RULE_ID]);
  });

  it("rejects a categoryIds list holding a non-uuid", () => {
    expect(
      listExpensesQuery.safeParse({ categoryIds: `${CATEGORY_ID},nope` })
        .success,
    ).toBe(false);
  });

  // Every other filter is bounded (limit 100, q 100 chars). Without a cap here,
  // a short query string expands into an arbitrarily large SQL IN clause.
  it("caps categoryIds at 50 entries", () => {
    const list = (n: number) =>
      Array.from({ length: n }, () => CATEGORY_ID).join(",");
    expect(
      listExpensesQuery.parse({ categoryIds: list(50) }).categoryIds,
    ).toHaveLength(50);
    expect(listExpensesQuery.safeParse({ categoryIds: list(51) }).success).toBe(
      false,
    );
    expect(
      listExpensesQuery.safeParse({ categoryIds: list(10_000) }).success,
    ).toBe(false);
  });

  it("rejects an impossible from date", () => {
    expect(listExpensesQuery.safeParse({ from: "2025-02-31" }).success).toBe(
      false,
    );
  });
});

/**
 * design/api.md: the CSV export takes "same filters as list". The two schemas
 * are built from one base so that sentence is enforced rather than documented —
 * a filter added to the list and forgotten on the export is not expressible.
 */
describe("exportExpensesQuery", () => {
  it("is the list query with pagination removed, and nothing else", () => {
    expect(Object.keys(exportExpensesQuery.shape).sort()).toEqual(
      Object.keys(listExpensesQuery.shape)
        .filter((k) => k !== "cursor" && k !== "limit")
        .sort(),
    );
  });

  it("applies the same filter rules as the list", () => {
    expect(exportExpensesQuery.safeParse({ q: "a".repeat(101) }).success).toBe(
      false,
    );
    expect(exportExpensesQuery.safeParse({ from: "2025-02-31" }).success).toBe(
      false,
    );
    expect(
      exportExpensesQuery.parse({ categoryIds: `${CATEGORY_ID},${RULE_ID}` })
        .categoryIds,
    ).toEqual([CATEGORY_ID, RULE_ID]);
  });

  it("strips pagination rather than honouring it", () => {
    const parsed: Record<string, unknown> = exportExpensesQuery.parse({
      limit: "1",
      cursor: "abc",
    });
    expect(parsed).toEqual({});
  });

  it("parses a list response with first-page totals", () => {
    const parsed = listExpensesResponse.parse({
      items: [],
      nextCursor: null,
      totalCount: 0,
      totalAmountMinor: 0,
    });
    expect(parsed.totalCount).toBe(0);
    expect(
      listExpensesResponse.parse({ items: [], nextCursor: "abc" }).totalCount,
    ).toBeUndefined();
  });
});

describe("budget schemas", () => {
  it("accepts an amount", () => {
    expect(
      budgetPutBody.parse({
        categoryId: CATEGORY_ID,
        month: "2026-08",
        amountMinor: 5000000,
      }).amountMinor,
    ).toBe(5000000);
  });

  it("accepts null to clear the budget from that month forward", () => {
    expect(
      budgetPutBody.parse({
        categoryId: CATEGORY_ID,
        month: "2026-08",
        amountMinor: null,
      }).amountMinor,
    ).toBeNull();
  });

  it("accepts zero — a deliberate 'spend nothing' budget", () => {
    expect(
      budgetPutBody.parse({
        categoryId: CATEGORY_ID,
        month: "2026-08",
        amountMinor: 0,
      }).amountMinor,
    ).toBe(0);
  });

  it("rejects a negative or fractional amount", () => {
    const base = { categoryId: CATEGORY_ID, month: "2026-08" };
    expect(budgetPutBody.safeParse({ ...base, amountMinor: -1 }).success).toBe(
      false,
    );
    expect(
      budgetPutBody.safeParse({ ...base, amountMinor: 12.34 }).success,
    ).toBe(false);
  });

  it("rejects a full date where a month belongs", () => {
    expect(
      budgetPutBody.safeParse({
        categoryId: CATEGORY_ID,
        month: "2026-08-01",
        amountMinor: 1,
      }).success,
    ).toBe(false);
  });

  it("rejects a missing amountMinor — null is explicit, absent is not", () => {
    expect(
      budgetPutBody.safeParse({ categoryId: CATEGORY_ID, month: "2026-08" })
        .success,
    ).toBe(false);
  });

  it("query takes a month", () => {
    expect(budgetsGetQuery.parse({ month: "2026-08" }).month).toBe("2026-08");
    expect(budgetsGetQuery.safeParse({ month: "2026-13" }).success).toBe(false);
  });

  it("parses the effective-budget response", () => {
    const parsed = budgetsGetResponse.parse({
      items: [
        {
          categoryId: CATEGORY_ID,
          amountMinor: 5000000,
          effectiveFrom: "2026-01",
        },
        { categoryId: RULE_ID, amountMinor: null, effectiveFrom: "2025-11" },
      ],
    });
    expect(parsed.items).toHaveLength(2);
    expect(
      budgetsGetResponse.safeParse({
        items: [
          { categoryId: CATEGORY_ID, amountMinor: 1, effectiveFrom: "nope" },
        ],
      }).success,
    ).toBe(false);
  });

  it("parses a budget dto", () => {
    const row = {
      id: EXPENSE_ID,
      categoryId: CATEGORY_ID,
      month: "2026-08",
      amountMinor: 5000000,
      currency: "LKR",
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(budgetDto.parse(row)).toEqual(row);
    expect(budgetDto.safeParse({ ...row, amountMinor: -1 }).success).toBe(
      false,
    );
  });
});

describe("recurring schemas", () => {
  const valid = {
    categoryId: CATEGORY_ID,
    amountMinor: 4500000,
    description: "Rent",
    frequency: "monthly",
    startDate: "2026-01-31",
  };

  it("accepts a create body", () => {
    expect(createRecurringBody.parse(valid)).toEqual(valid);
  });

  it("accepts an endDate on or after startDate", () => {
    expect(
      createRecurringBody.safeParse({ ...valid, endDate: "2026-01-31" })
        .success,
    ).toBe(true);
    expect(
      createRecurringBody.safeParse({ ...valid, endDate: "2027-01-31" })
        .success,
    ).toBe(true);
  });

  it("rejects an endDate before startDate", () => {
    expect(
      createRecurringBody.safeParse({ ...valid, endDate: "2025-12-31" })
        .success,
    ).toBe(false);
  });

  it("rejects a frequency outside weekly|monthly", () => {
    expect(
      createRecurringBody.safeParse({ ...valid, frequency: "daily" }).success,
    ).toBe(false);
  });

  it("rejects a zero amount and an empty description", () => {
    expect(
      createRecurringBody.safeParse({ ...valid, amountMinor: 0 }).success,
    ).toBe(false);
    expect(
      createRecurringBody.safeParse({ ...valid, description: "" }).success,
    ).toBe(false);
  });

  it("carries no nextOccurrence — the server derives it", () => {
    expect(
      createRecurringBody.parse({ ...valid, nextOccurrence: "2026-02-28" }),
    ).toEqual(valid);
  });

  it("patch is partial and still checks endDate against startDate when both are present", () => {
    expect(patchRecurringBody.parse({})).toEqual({});
    expect(
      patchRecurringBody.safeParse({ endDate: "2030-01-01" }).success,
    ).toBe(true);
    expect(
      patchRecurringBody.safeParse({
        startDate: "2026-01-31",
        endDate: "2025-12-31",
      }).success,
    ).toBe(false);
  });

  it("parses a rule dto", () => {
    const row = {
      id: RULE_ID,
      categoryId: CATEGORY_ID,
      amountMinor: 4500000,
      currency: "LKR",
      description: "Rent",
      notes: null,
      frequency: "monthly",
      startDate: "2026-01-31",
      endDate: null,
      nextOccurrence: "2026-02-28",
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(recurringRuleDto.parse(row)).toEqual(row);
    expect(
      recurringRuleDto.safeParse({ ...row, nextOccurrence: null }).success,
    ).toBe(false);
  });
});

describe("report schemas", () => {
  it("accepts a valid range", () => {
    expect(
      reportRangeQuery.parse({ from: "2026-01-01", to: "2026-01-31" }).to,
    ).toBe("2026-01-31");
  });

  it("accepts from === to", () => {
    expect(
      reportRangeQuery.safeParse({ from: "2026-01-01", to: "2026-01-01" })
        .success,
    ).toBe(true);
  });

  it("rejects from > to", () => {
    expect(
      reportRangeQuery.safeParse({ from: "2026-02-01", to: "2026-01-01" })
        .success,
    ).toBe(false);
  });

  it("rejects a span longer than 5 years", () => {
    expect(
      reportRangeQuery.safeParse({ from: "2021-01-01", to: "2026-01-01" })
        .success,
    ).toBe(true);
    expect(
      reportRangeQuery.safeParse({ from: "2021-01-01", to: "2026-01-02" })
        .success,
    ).toBe(false);
  });

  it("requires both bounds", () => {
    expect(reportRangeQuery.safeParse({ from: "2026-01-01" }).success).toBe(
      false,
    );
  });

  it("topExpensesQuery defaults limit to 5 and caps it at 20", () => {
    const range = { from: "2026-01-01", to: "2026-01-31" };
    expect(topExpensesQuery.parse(range).limit).toBe(5);
    expect(topExpensesQuery.parse({ ...range, limit: "20" }).limit).toBe(20);
    expect(topExpensesQuery.safeParse({ ...range, limit: "21" }).success).toBe(
      false,
    );
  });

  it("topExpensesQuery keeps the range rules", () => {
    expect(
      topExpensesQuery.safeParse({ from: "2026-02-01", to: "2026-01-01" })
        .success,
    ).toBe(false);
  });

  it("parses the summary response", () => {
    const parsed = summaryResponse.parse({
      totalMinor: 125000,
      count: 3,
      avgMinor: 41666.67,
      prevPeriodTotalMinor: 100000,
      deltaPct: 0.25,
    });
    expect(parsed.deltaPct).toBe(0.25);
    expect(
      summaryResponse.parse({
        totalMinor: 0,
        count: 0,
        avgMinor: 0,
        prevPeriodTotalMinor: 0,
        deltaPct: null,
      }).deltaPct,
    ).toBeNull();
    expect(
      summaryResponse.safeParse({
        totalMinor: 1.5,
        count: 1,
        avgMinor: 1.5,
        prevPeriodTotalMinor: 0,
        deltaPct: null,
      }).success,
    ).toBe(false);
  });

  it("lets an aggregated total be omitted past the exact-integer ceiling, never rounded", () => {
    // design/api.md: a sum of capped rows can exceed 2^53 - 1; the field is
    // then absent. Counts and ratios are never optional.
    expect(
      summaryResponse.parse({
        count: 2,
        avgMinor: 9007199254740991,
        deltaPct: 1,
      }),
    ).toEqual({ count: 2, avgMinor: 9007199254740991, deltaPct: 1 });
    expect(
      summaryResponse.safeParse({
        totalMinor: 9007199254740992,
        count: 2,
        avgMinor: 0,
        deltaPct: null,
      }).success,
    ).toBe(false);
    expect(
      byCategoryResponse.parse({
        items: [{ categoryId: CATEGORY_ID, share: 1 }],
      }).items[0],
    ).toEqual({ categoryId: CATEGORY_ID, share: 1 });
    expect(
      trendResponse.parse({ items: [{ month: "2026-01" }] }).items[0],
    ).toEqual({ month: "2026-01" });
    expect(
      budgetStatusResponse.parse({
        items: [{ categoryId: CATEGORY_ID, budgetMinor: 5000 }],
      }).items[0],
    ).toEqual({ categoryId: CATEGORY_ID, budgetMinor: 5000 });
  });

  it("parses the by-category response", () => {
    expect(
      byCategoryResponse.parse({
        items: [{ categoryId: CATEGORY_ID, totalMinor: 1, share: 1 }],
      }).items,
    ).toHaveLength(1);
    expect(
      byCategoryResponse.safeParse({
        items: [{ categoryId: CATEGORY_ID, totalMinor: 1, share: 1.5 }],
      }).success,
    ).toBe(false);
  });

  it("parses the trend response with months, not dates", () => {
    expect(
      trendResponse.parse({ items: [{ month: "2026-01", totalMinor: 0 }] })
        .items,
    ).toHaveLength(1);
    expect(
      trendResponse.safeParse({
        items: [{ month: "2026-01-01", totalMinor: 0 }],
      }).success,
    ).toBe(false);
  });

  it("parses the budget-status response, allowing overspend", () => {
    const parsed = budgetStatusResponse.parse({
      items: [
        {
          categoryId: CATEGORY_ID,
          budgetMinor: 100000,
          spentMinor: 150000,
          remainingMinor: -50000,
          pct: 1.5,
        },
        {
          categoryId: RULE_ID,
          budgetMinor: null,
          spentMinor: 0,
          remainingMinor: null,
          pct: null,
        },
      ],
    });
    expect(parsed.items[0]?.remainingMinor).toBe(-50000);
    expect(
      budgetStatusResponse.safeParse({
        items: [
          {
            categoryId: CATEGORY_ID,
            budgetMinor: 1,
            spentMinor: -1,
            remainingMinor: 0,
            pct: 0,
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("unknown keys", () => {
  // zod's default is strip. Never .passthrough() — an input schema that carries
  // unknown keys through is how a client-supplied userId reaches a repository.
  it("are stripped from input schemas, not preserved", () => {
    const parsed = createExpenseBody.parse({
      amountMinor: 1,
      categoryId: CATEGORY_ID,
      date: "2026-01-05",
      description: "x",
      userId: USER_ID,
      isAdmin: true,
    });
    expect(parsed).toEqual({
      amountMinor: 1,
      categoryId: CATEGORY_ID,
      date: "2026-01-05",
      description: "x",
    });
  });

  it("are stripped from output schemas, not preserved", () => {
    const parsed = categoryDto.parse({
      id: CATEGORY_ID,
      name: "Food",
      archivedAt: null,
      createdAt: NOW,
      userId: USER_ID,
    });
    expect(Object.keys(parsed)).toEqual([
      "id",
      "name",
      "archivedAt",
      "createdAt",
    ]);
  });

  it("are stripped from query schemas, not preserved", () => {
    expect(listExpensesQuery.parse({ orderBy: "amount" })).toEqual({
      limit: 50,
    });
  });
});
