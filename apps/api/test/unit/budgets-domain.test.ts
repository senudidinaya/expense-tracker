import { describe, expect, it } from "vitest";
import { resolveEffective, type BudgetRow } from "../../src/domain/budgets.js";

/**
 * Task 11, Step 1 — the effective-from model, as a pure function.
 *
 * design/schema.md: the effective budget for a category in month M is the row
 * with the greatest `month_start <= M`; if there is no such row, or its
 * `amount_minor` is NULL, the category is unbudgeted for M. History is never
 * rewritten — setting or clearing writes one row at one month, and the months
 * before it keep whatever they already resolved to.
 *
 * That rule is stated here, once, in a function that touches no database, so
 * the SQL in `repos/budgets.ts` has something to agree with rather than being
 * its own definition.
 */

const jan = (amountMinor: number | null): BudgetRow => ({
  monthStart: "2026-01-01",
  amountMinor,
});
const mar = (amountMinor: number | null): BudgetRow => ({
  monthStart: "2026-03-01",
  amountMinor,
});

describe("resolveEffective", () => {
  it("no rows -> null", () => {
    expect(resolveEffective([], "2026-02")).toBeNull();
  });

  it("row in earlier month carries forward", () => {
    expect(resolveEffective([jan(10_000)], "2026-02")).toEqual({
      amountMinor: 10_000,
      effectiveFrom: "2026-01",
    });
    // And still applies years later: nothing expires a budget but another row.
    expect(resolveEffective([jan(10_000)], "2031-12")).toEqual({
      amountMinor: 10_000,
      effectiveFrom: "2026-01",
    });
  });

  it("a row in the asked-for month itself applies", () => {
    // The bound is inclusive — `month_start <= M`, not `<`. An exclusive
    // comparison would make the month you set a budget in the one month it
    // does not apply to.
    expect(resolveEffective([jan(10_000)], "2026-01")).toEqual({
      amountMinor: 10_000,
      effectiveFrom: "2026-01",
    });
  });

  it("later row overrides from its month on; earlier months keep old value", () => {
    const rows = [jan(10_000), mar(25_000)];

    expect(resolveEffective(rows, "2026-02")).toEqual({
      amountMinor: 10_000,
      effectiveFrom: "2026-01",
    });
    expect(resolveEffective(rows, "2026-03")).toEqual({
      amountMinor: 25_000,
      effectiveFrom: "2026-03",
    });
    expect(resolveEffective(rows, "2026-04")).toEqual({
      amountMinor: 25_000,
      effectiveFrom: "2026-03",
    });
  });

  it("NULL amount clears from that month forward; earlier months unaffected", () => {
    const rows = [jan(10_000), mar(null)];

    expect(resolveEffective(rows, "2026-02")).toEqual({
      amountMinor: 10_000,
      effectiveFrom: "2026-01",
    });
    expect(resolveEffective(rows, "2026-03")).toEqual({
      amountMinor: null,
      effectiveFrom: "2026-03",
    });
    expect(resolveEffective(rows, "2026-12")).toEqual({
      amountMinor: null,
      effectiveFrom: "2026-03",
    });
  });

  it("row in future month does not apply to current", () => {
    expect(resolveEffective([mar(25_000)], "2026-02")).toBeNull();
    // Not even by a month, and not by starting from the wrong end of the list.
    expect(resolveEffective([jan(10_000), mar(25_000)], "2026-01")).toEqual({
      amountMinor: 10_000,
      effectiveFrom: "2026-01",
    });
  });

  /**
   * The two states that both render as "unbudgeted" are not the same answer.
   *
   * A NULL amount is a decision the user recorded — "no budget for this
   * category from March on" — and it carries provenance: the month they made
   * it. No row at all is the absence of any such decision. Collapsing the
   * cleared row to `null` would lose the month, and the API would have no way
   * to tell a user who cleared a budget from one who never set one; collapsing
   * the other way would invent an `effectiveFrom` out of nothing.
   */
  it("a cleared row and no row at all are different answers", () => {
    const cleared = resolveEffective([mar(null)], "2026-04");
    const nothing = resolveEffective([], "2026-04");

    expect(cleared).toEqual({ amountMinor: null, effectiveFrom: "2026-03" });
    expect(nothing).toBeNull();

    // Both are "unbudgeted" to a reader of `amountMinor` alone, which is
    // exactly why the distinction has to live somewhere else.
    expect(cleared?.amountMinor ?? null).toBeNull();
    expect(nothing).not.toEqual(cleared);
  });

  /**
   * Order independence. The repository's query happens to hand these over
   * sorted (`ORDER BY category_id, month_start DESC`), and a function that
   * quietly relied on that — took the first row, or the last — would keep
   * passing every test above while being wrong the moment the SQL grew an
   * index scan that returned rows in a different order.
   *
   * All 24 permutations rather than one shuffle: a fixed set, no randomness,
   * and a failure names the exact ordering that broke it.
   */
  it("is not fooled by rows arriving out of order", () => {
    const rows: BudgetRow[] = [
      { monthStart: "2025-11-01", amountMinor: 5_000 },
      jan(10_000),
      mar(null),
      { monthStart: "2026-06-01", amountMinor: 40_000 },
    ];

    const expected = {
      "2025-10": null,
      "2025-11": { amountMinor: 5_000, effectiveFrom: "2025-11" },
      "2025-12": { amountMinor: 5_000, effectiveFrom: "2025-11" },
      "2026-02": { amountMinor: 10_000, effectiveFrom: "2026-01" },
      "2026-04": { amountMinor: null, effectiveFrom: "2026-03" },
      "2026-07": { amountMinor: 40_000, effectiveFrom: "2026-06" },
    };

    for (const ordering of permutations(rows)) {
      for (const [month, answer] of Object.entries(expected)) {
        expect(
          resolveEffective(ordering, month),
          `month ${month}, rows ordered ${ordering.map((r) => r.monthStart).join(",")}`,
        ).toEqual(answer);
      }
    }
  });
});

/** Every ordering of `items`. Small inputs only — this is n! by construction. */
function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [
      item,
      ...rest,
    ]),
  );
}
