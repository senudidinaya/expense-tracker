import { describe, expect, it } from "vitest";
import { listExpensesQuery } from "@expense/shared";
import { filtersToSearchParams, type ExpenseFilters } from "./filters";

describe("filtersToSearchParams", () => {
  it("serializes from/to/q/limit and comma-joins categoryIds", () => {
    const categoryId1 = crypto.randomUUID();
    const categoryId2 = crypto.randomUUID();
    const filters: ExpenseFilters = {
      from: "2026-01-01",
      to: "2026-01-31",
      categoryIds: [categoryId1, categoryId2],
      q: "coffee",
      limit: 25,
    };

    const params = filtersToSearchParams(filters);

    expect(params.get("from")).toBe("2026-01-01");
    expect(params.get("to")).toBe("2026-01-31");
    expect(params.get("categoryIds")).toBe(`${categoryId1},${categoryId2}`);
    expect(params.get("q")).toBe("coffee");
    expect(params.get("limit")).toBe("25");
  });

  it("omits empty and undefined values", () => {
    const filters: ExpenseFilters = {
      from: undefined,
      to: undefined,
      categoryIds: [],
      q: "",
      limit: undefined,
    };

    const params = filtersToSearchParams(filters);

    expect([...params.keys()]).toEqual([]);
  });

  it("output round-trips through listExpensesQuery.parse — the server accepts exactly what the client sends", () => {
    const categoryId = crypto.randomUUID();
    const filters: ExpenseFilters = {
      from: "2026-02-01",
      to: "2026-02-28",
      categoryIds: [categoryId],
      q: "rent",
      limit: 10,
    };

    const params = filtersToSearchParams(filters);
    const parsed = listExpensesQuery.parse(Object.fromEntries(params));

    expect(parsed).toEqual({
      from: filters.from,
      to: filters.to,
      categoryIds: filters.categoryIds,
      q: filters.q,
      limit: filters.limit,
    });
  });
});
