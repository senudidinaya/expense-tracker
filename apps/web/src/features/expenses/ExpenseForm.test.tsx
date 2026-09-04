import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Category, Expense } from "@expense/shared";
import { ExpenseForm } from "./ExpenseForm";

/**
 * Task 20 BLOCKER 1 regression suite.
 *
 * Root cause (per the bug report): `ExpenseForm`'s single `amountMinor`
 * react-hook-form field holds raw minor units whenever `reset()` writes it
 * (on mount, and whenever the `expense` prop changes), but `setValueAs`
 * reads the field's *displayed* value as rupees on submit. The JSX
 * `defaultValue={(expense.amountMinor / 100).toFixed(2)}` on the amount
 * `<input>` is dead code for every edit except the very first one: the
 * effect that calls `reset()` runs after every mount too, so it overwrites
 * that `defaultValue` before a user ever sees it. An untouched edit of a
 * Rs 500.00 expense (`amountMinor: 50000`) therefore resubmits
 * `amountMinor: 5000000` — 100x too large.
 *
 * These tests mount `ExpenseForm` the way `ExpensesPage` actually does: one
 * instance, `expense` supplied or changed via props, never remounted.
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

/** Rs 500.00 — the fixture the bug report itself uses. */
const EXPENSE_A: Expense = {
  id: "0192f1d6-0000-7000-8000-000000000a01",
  categoryId: CATEGORY_A.id,
  recurringRuleId: null,
  amountMinor: 50000,
  currency: "LKR",
  date: "2026-08-01",
  description: "Weekly shop",
  notes: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

/** Rs 750.00, a different category — for the prop-switch test. */
const EXPENSE_B: Expense = {
  id: "0192f1d6-0000-7000-8000-000000000b02",
  categoryId: CATEGORY_B.id,
  recurringRuleId: null,
  amountMinor: 75000,
  currency: "LKR",
  date: "2026-08-10",
  description: "Bus pass",
  notes: null,
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:00:00.000Z",
};

// The label's accessible text includes the required-field "*" (rendered as
// a nested, aria-hidden <span> that testing-library's textContent-based
// label matching still concatenates in), so an exact "Amount" never matches.
function amountInput(): HTMLInputElement {
  return screen.getByLabelText(/^Amount/) as HTMLInputElement;
}

describe("ExpenseForm — amount field", () => {
  it("displays the expense's amount in rupees, not minor units", () => {
    render(
      <ExpenseForm
        open
        onClose={() => {}}
        categories={CATEGORIES}
        expense={EXPENSE_A}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    // 50000 minor units is Rs 500.00. The field must never show the raw
    // minor-unit integer ("50000") as if it were a rupee amount.
    expect(amountInput().value).toBe("500.00");
  });

  it("regression: submitting an untouched edit sends amountMinor unchanged, not x100", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const person = userEvent.setup();

    render(
      <ExpenseForm
        open
        onClose={() => {}}
        categories={CATEGORIES}
        expense={EXPENSE_A}
        onSubmit={onSubmit}
      />,
    );

    // Deliberately touch nothing — this is the "open an expense and hit
    // save" path, not a re-entry of the amount.
    await person.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const submitted = onSubmit.mock.calls[0]?.[0] as { amountMinor: number };
    expect(submitted.amountMinor).toBe(50000);
  });

  it("rejects a third decimal digit instead of rounding it, and blocks submit", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const person = userEvent.setup();

    render(
      <ExpenseForm
        open
        onClose={() => {}}
        categories={CATEGORIES}
        expense={EXPENSE_A}
        onSubmit={onSubmit}
      />,
    );

    await person.clear(amountInput());
    await person.type(amountInput(), "12.345");
    await person.click(screen.getByRole("button", { name: "Save changes" }));

    // Blocking submit is the property that matters — check it before the
    // waitFor below, so a stuck field-level error can't hide a submit call
    // behind its own timeout.
    expect(onSubmit).not.toHaveBeenCalled();

    // A field-level error, not a silently rounded amount.
    await waitFor(() =>
      expect(amountInput()).toHaveAttribute("aria-invalid", "true"),
    );
  });

  // `parseRupeesToMinor("0")` returns 0 — "0" is well-formed rupee syntax, and
  // the parser deliberately has no opinion on the value. "an expense costs
  // more than nothing" is `amountMinor.positive()`'s rule, and this is the
  // test that it still reaches the user as a field error after that rule moved
  // out of the parser.
  it("rejects a zero amount, and blocks submit", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const person = userEvent.setup();

    render(
      <ExpenseForm
        open
        onClose={() => {}}
        categories={CATEGORIES}
        expense={EXPENSE_A}
        onSubmit={onSubmit}
      />,
    );

    await person.clear(amountInput());
    await person.type(amountInput(), "0");
    await person.click(screen.getByRole("button", { name: "Save changes" }));

    expect(onSubmit).not.toHaveBeenCalled();

    await waitFor(() =>
      expect(amountInput()).toHaveAttribute("aria-invalid", "true"),
    );
  });

  it("re-seeds the amount field when the expense prop changes (the reset() path)", () => {
    // Starts exactly as `ExpensesPage` starts it: one `ExpenseForm` mounted
    // with no expense (the closed/"Add" state), never remounted afterwards.
    // This isolates the reset()-driven re-seed from the mount-time
    // `defaultValue` bug already covered by the first test in this file —
    // by the time `expense` is ever non-null here, the component has already
    // mounted once.
    const { rerender } = render(
      <ExpenseForm
        open
        onClose={() => {}}
        categories={CATEGORIES}
        expense={undefined}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    // "Edit <row A>": the panel's `expense` prop changes on the same
    // instance — exactly how `ExpensesPage` opens an edit.
    rerender(
      <ExpenseForm
        open
        onClose={() => {}}
        categories={CATEGORIES}
        expense={EXPENSE_A}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    // 50000 minor units is Rs 500.00 — not "50000" written raw by reset().
    expect(amountInput().value).toBe("500.00");

    // "Edit <row B>" without ever closing the panel in between — the second
    // switch this test exists to check, since a fix that only handles the
    // first reset() call would still be broken here.
    rerender(
      <ExpenseForm
        open
        onClose={() => {}}
        categories={CATEGORIES}
        expense={EXPENSE_B}
        onSubmit={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    // 75000 minor units is Rs 750.00 — not "500.00" left stale, and not
    // "75000" written raw by reset().
    expect(amountInput().value).toBe("750.00");
  });
});
