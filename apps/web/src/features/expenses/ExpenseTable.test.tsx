import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Category, Expense } from "@expense/shared";
import { ExpenseTable } from "./ExpenseTable";

/**
 * Review finding #1: an optimistic row's Edit and Delete were live.
 *
 * `useCreateExpense` puts the new row in the cache before the POST is sent,
 * with a placeholder id ("optimistic-0"). Both id-taking routes validate
 * `:id` as a uuid, so acting on that row could only ever produce a 400 —
 * Edit opened the form and PATCHed a placeholder, Delete DELETEd one. The
 * user did nothing wrong: the row looked exactly like its neighbours.
 */

const CATEGORY: Category = {
  id: "0192f1d6-0000-7000-8000-0000000000a1",
  name: "Groceries",
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const SAVED: Expense = {
  id: "0192f1d6-0000-7000-8000-000000000a01",
  categoryId: CATEGORY.id,
  recurringRuleId: null,
  amountMinor: 50000,
  currency: "LKR",
  date: "2026-08-01",
  description: "Weekly shop",
  notes: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

/** Shaped exactly as `useCreateExpense.onMutate` shapes it. */
const OPTIMISTIC: Expense = {
  ...SAVED,
  id: "optimistic-0",
  description: "Bus pass",
};

function renderTable(items: Expense[]) {
  const onEdit = vi.fn();
  const onDelete = vi.fn();
  render(
    <ExpenseTable
      items={items}
      categoriesById={new Map([[CATEGORY.id, CATEGORY]])}
      loading={false}
      onEdit={onEdit}
      onDelete={onDelete}
    />,
  );
  return { onEdit, onDelete };
}

/** The `<tr>` containing the given description. */
function rowFor(description: string): HTMLElement {
  const cell = screen.getByText(description);
  const row = cell.closest("tr");
  if (row === null) throw new Error(`no row found for ${description}`);
  return row;
}

describe("ExpenseTable — row actions on an unsaved row", () => {
  it("disables Edit and Delete while a row is still optimistic", () => {
    renderTable([OPTIMISTIC, SAVED]);

    const pending = within(rowFor("Bus pass"));
    expect(pending.getByRole("button", { name: "Edit" })).toBeDisabled();
    expect(pending.getByRole("button", { name: "Delete" })).toBeDisabled();
  });

  it("leaves the actions on a saved row alone", () => {
    renderTable([OPTIMISTIC, SAVED]);

    const saved = within(rowFor("Weekly shop"));
    expect(saved.getByRole("button", { name: "Edit" })).toBeEnabled();
    expect(saved.getByRole("button", { name: "Delete" })).toBeEnabled();
  });

  it("does not fire onEdit or onDelete when an optimistic row's actions are clicked", async () => {
    // `pointerEventsCheck: 0` so this asserts on the handlers rather than on
    // user-event's own refusal to click a disabled control — the point is
    // that nothing reaches the page, not how the click was stopped.
    const person = userEvent.setup({ pointerEventsCheck: 0 });
    const { onEdit, onDelete } = renderTable([OPTIMISTIC, SAVED]);
    const pending = within(rowFor("Bus pass"));

    await person.click(pending.getByRole("button", { name: "Edit" }));
    await person.click(pending.getByRole("button", { name: "Delete" }));

    expect(onEdit).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("marks the unsaved row as busy for assistive tech", () => {
    renderTable([OPTIMISTIC, SAVED]);

    expect(rowFor("Bus pass")).toHaveAttribute("aria-busy", "true");
    expect(rowFor("Weekly shop")).not.toHaveAttribute("aria-busy");
  });
});
