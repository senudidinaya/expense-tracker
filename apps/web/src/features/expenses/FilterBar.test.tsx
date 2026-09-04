import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Category } from "@expense/shared";
import { FilterBar, type FilterBarProps } from "./FilterBar";
import type { ExpenseFilters } from "./filters";

/**
 * Task 20 BLOCKER 2 regression suite.
 *
 * Root cause: the search debounce armed a `setTimeout` whose closure held the
 * `filters` object from the render that armed it, and the effect was keyed on
 * `[searchInput]` alone — so a date or category change never cleared that
 * timer. When it fired it did a read-modify-write of the *whole* filter
 * object (`onChange({ ...filters, q })`) while owning exactly one field, and
 * silently discarded whatever the other controls had set in the meantime.
 * Type "c", pick a date range inside the 300ms window, and the date range
 * vanished. The same effect also fired once on mount, replacing `{}` with a
 * fresh `{}` for no reason.
 *
 * These tests drive a stateful harness that holds real `ExpenseFilters` state
 * and hands `FilterBar` its setter — the way `ExpensesPage` does. That is
 * deliberate: asserting on `onChange`'s arguments would pass just as happily
 * against the broken version, because the bug is not in what `FilterBar`
 * computes but in what it computes it *from*. Only real state composed across
 * two controls can tell the difference.
 *
 * Interactions here are `fireEvent`, not `userEvent`, which is a departure
 * from the other component tests in this workspace and is the point: every
 * assertion below is about what has or has not happened *at a given point on
 * the clock*, so the clock has to be fake — and `userEvent` awaits real
 * timers internally, so under `vi.useFakeTimers()` its first keystroke never
 * resolves and the test times out instead of failing. `fireEvent` is
 * synchronous and act-wrapped, which leaves time entirely under the test's
 * control. `fireEvent.change` is what React's `onChange` sees from a
 * keystroke anyway.
 */

const CATEGORY_A: Category = {
  id: "0192f1d6-0000-7000-8000-0000000000a1",
  name: "Groceries",
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const CATEGORY_B: Category = {
  id: "0192f1d6-0000-7000-8000-0000000000b2",
  name: "Transport",
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const CATEGORIES: Category[] = [CATEGORY_A, CATEGORY_B];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Comfortably longer than `SEARCH_DEBOUNCE_MS`. The tests assert on what has
 * and has not happened either side of the debounce, never on its exact
 * length, so the constant itself stays private to the component.
 */
const PAST_DEBOUNCE_MS = 1000;

/** Advances the fake clock inside `act`, so React commits whatever a timer triggered. */
async function advanceClock(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Advances past any pending debounce, whatever its exact length. */
async function flushTimers(): Promise<void> {
  await advanceClock(PAST_DEBOUNCE_MS);
}

/**
 * Holds the filter state for real and passes its setter straight through, so
 * a functional updater from `FilterBar` is applied by React against the
 * latest state rather than against a snapshot the test took.
 */
function Harness({ onChange: spy }: { onChange?: (next: unknown) => void }) {
  const [filters, setFilters] = useState<ExpenseFilters>({});

  const handleChange: FilterBarProps["onChange"] = (next) => {
    spy?.(next);
    setFilters(next);
  };

  return (
    <>
      <FilterBar
        filters={filters}
        onChange={handleChange}
        categories={CATEGORIES}
      />
      {/* The window into the harness's state. `<output>` is role="status". */}
      <output>{JSON.stringify(filters)}</output>
    </>
  );
}

function currentFilters(): ExpenseFilters {
  return JSON.parse(
    screen.getByRole("status").textContent ?? "{}",
  ) as ExpenseFilters;
}

/** One keystroke, as React sees it: the input's new full value. */
function typeSearch(value: string): void {
  fireEvent.change(screen.getByLabelText("Search"), { target: { value } });
}

function pickThisMonth(): void {
  fireEvent.click(screen.getByRole("button", { name: "This month" }));
}

afterEach(() => {
  vi.useRealTimers();
});

describe("FilterBar", () => {
  it("keeps a date range picked while the search debounce is still pending", async () => {
    vi.useFakeTimers();
    render(<Harness />);

    // The exact interleaving from the bug report: a keystroke arms the
    // debounce, and the date range is chosen before it elapses.
    typeSearch("c");
    pickThisMonth();

    // The date control writes immediately, so it is in state already...
    expect(currentFilters().from).toMatch(ISO_DATE);

    // ...and must still be there after the in-flight debounce lands `q`.
    await flushTimers();

    const final = currentFilters();
    expect(final.q).toBe("c");
    expect(final.from).toMatch(ISO_DATE);
  });

  it("keeps a date range picked before the search is typed", async () => {
    vi.useFakeTimers();
    render(<Harness />);

    pickThisMonth();
    expect(currentFilters().from).toMatch(ISO_DATE);

    // Picking a range and only then deciding to search is the ordinary way
    // round, and it involves a pause. Nothing armed earlier — the mount, in
    // the broken version — may reach back and undo the range during it.
    await flushTimers();
    expect(currentFilters().from).toMatch(ISO_DATE);

    typeSearch("c");
    await flushTimers();

    const final = currentFilters();
    expect(final.q).toBe("c");
    expect(final.from).toMatch(ISO_DATE);
  });

  it("keeps a category picked while the search debounce is still pending", async () => {
    vi.useFakeTimers();
    render(<Harness />);

    // Same class of bug as the date range, one control over: `toggleCategory`
    // also owned one field and rewrote the whole object.
    typeSearch("c");
    fireEvent.click(screen.getByLabelText(/Groceries/));

    expect(currentFilters().categoryIds).toEqual([CATEGORY_A.id]);

    await flushTimers();

    const final = currentFilters();
    expect(final.q).toBe("c");
    expect(final.categoryIds).toEqual([CATEGORY_A.id]);
  });

  it("debounces: three keystrokes in quick succession produce exactly one q update", async () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    // Spaced by less than the debounce, but adding up to more than it: this
    // is what separates a debounce from a throttle. A timer that is not
    // restarted by each keystroke — or that has no delay at all — has fired
    // by the end of this sequence.
    typeSearch("c");
    await advanceClock(100);
    typeSearch("ca");
    await advanceClock(100);
    typeSearch("cat");
    await advanceClock(100);

    expect(onChange).not.toHaveBeenCalled();

    await flushTimers();

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(currentFilters().q).toBe("cat");
  });

  it("does not call onChange on mount, before any interaction", async () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    await flushTimers();

    // Mounting is not a filter change. A fresh `{}` for the old `{}` is a new
    // object identity, which is a new query key downstream.
    expect(onChange).not.toHaveBeenCalled();
    expect(currentFilters()).toEqual({});
  });
});
