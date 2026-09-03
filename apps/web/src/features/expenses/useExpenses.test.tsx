import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateExpenseBody, ListExpensesResponse } from "@expense/shared";
import { ApiError } from "../../api/client";
import { useCreateExpense, useExpenses } from "./useExpenses";
import type { ExpenseFilters } from "./filters";

vi.mock("../../api/client", async () => {
  const actual =
    await vi.importActual<typeof import("../../api/client")>(
      "../../api/client",
    );
  return { ...actual, apiFetch: vi.fn() };
});

import { apiFetch } from "../../api/client";

const apiFetchMock = vi.mocked(apiFetch);

const FILTERS: ExpenseFilters = {};

const FIRST_PAGE: ListExpensesResponse = {
  items: [
    {
      id: "existing-1",
      categoryId: "cat-1",
      recurringRuleId: null,
      amountMinor: 50000,
      currency: "LKR",
      date: "2026-08-01",
      description: "Groceries",
      notes: null,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    },
  ],
  nextCursor: null,
  totalCount: 1,
  totalAmountMinor: 50000,
};

const NEW_EXPENSE_BODY: CreateExpenseBody = {
  amountMinor: 12000,
  categoryId: "cat-2",
  date: "2026-08-05",
  description: "Coffee",
};

/** Renders the first page of `useExpenses` plus a button that fires `useCreateExpense`. */
function Harness() {
  const { data } = useExpenses(FILTERS);
  const createExpense = useCreateExpense(FILTERS);
  const items = data?.pages[0]?.items ?? [];

  return (
    <div>
      <ul>
        {items.map((item) => (
          <li key={item.id}>{item.description}</li>
        ))}
      </ul>
      <button onClick={() => void createExpense.mutate(NEW_EXPENSE_BODY)}>
        Add
      </button>
      {createExpense.isError ? <p role="alert">create failed</p> : null}
    </div>
  );
}

function renderHarness() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, ...render(<Harness />, { wrapper }) };
}

describe("useExpenses / useCreateExpense", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("optimistic add: new row is present in the rendered first page before the mutation resolves", async () => {
    apiFetchMock.mockResolvedValueOnce(FIRST_PAGE);
    const { getByText } = renderHarness();

    await waitFor(() => expect(screen.getByText("Groceries")).toBeTruthy());

    // The create call never resolves during this test — resolving it would
    // move past the moment this test exists to check.
    apiFetchMock.mockImplementationOnce(() => new Promise(() => {}));

    getByText("Add").click();

    await waitFor(() => expect(screen.getByText("Coffee")).toBeTruthy());
  });

  it("rollback: mutation rejects with a 400 ApiError -> optimistic row removed, cache identical to pre-mutation snapshot, error surfaced", async () => {
    apiFetchMock.mockResolvedValueOnce(FIRST_PAGE);
    const { getByText, queryClient } = renderHarness();

    await waitFor(() => expect(screen.getByText("Groceries")).toBeTruthy());
    const snapshot = queryClient.getQueryData(["expenses", FILTERS]);

    apiFetchMock.mockRejectedValueOnce(
      new ApiError({
        code: "validation_failed",
        message: "Invalid request",
        status: 400,
      }),
    );

    getByText("Add").click();

    // The rejection settles the mutation; wait for its final signal rather
    // than for the optimistic row, which can come and go between polls.
    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());

    expect(screen.queryByText("Coffee")).toBeNull();
    expect(queryClient.getQueryData(["expenses", FILTERS])).toEqual(snapshot);
  });
});
