import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Category, Expense, ListExpensesResponse } from "@expense/shared";

vi.mock("../../api/client", async () => {
  const actual =
    await vi.importActual<typeof import("../../api/client")>(
      "../../api/client",
    );
  return { ...actual, apiFetch: vi.fn() };
});

import { ApiError, apiFetch } from "../../api/client";
import { ExpensesPage } from "./ExpensesPage";

const apiFetchMock = vi.mocked(apiFetch);

/**
 * Task 20 BLOCKER 3 regression suite.
 *
 * `useDeleteExpense` had an `onSuccess` and nothing else, and
 * `ExpensesPage.handleDelete` called `.mutate()` fire-and-forget without ever
 * reading `isError`. A 500 or a dropped connection therefore produced no
 * banner, no toast, and no change on screen: the row stayed exactly where it
 * was and the user concluded the delete had worked. The hook's own docstring
 * argued for the non-optimistic design on the grounds that a user who has
 * moved on "never learns it failed" — which is precisely what shipped.
 *
 * These tests live in their own file rather than in `useExpenses.test.tsx`
 * because the bug is not in the hook's mutation state — that was always
 * correct — but in nobody rendering it. `useExpenses.test.tsx` mounts a
 * synthetic hook harness, so proving "a user sees the failure" there would
 * mean building a second, page-shaped harness inside it and asserting against
 * that instead of against the real page.
 */

const CATEGORY: Category = {
  id: "0192f1d6-0000-7000-8000-0000000000a1",
  name: "Groceries",
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const EXPENSE: Expense = {
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

const PAGE_WITH_EXPENSE: ListExpensesResponse = {
  items: [EXPENSE],
  nextCursor: null,
  totalCount: 1,
  totalAmountMinor: EXPENSE.amountMinor,
};

const EMPTY_PAGE: ListExpensesResponse = {
  items: [],
  nextCursor: null,
  totalCount: 0,
  totalAmountMinor: 0,
};

/** The message the fake server sends back on the failed delete. */
const SERVER_MESSAGE = "The expense could not be deleted.";

interface Routes {
  /** One entry per list fetch, in order; the last one repeats. */
  listPages: ListExpensesResponse[];
  delete: () => Promise<undefined>;
}

/** Number of `GET /expenses` calls so far — a refetch is how invalidation shows. */
let listCalls = 0;

function routeApi(routes: Routes): void {
  listCalls = 0;
  apiFetchMock.mockImplementation((_schema, path, init) => {
    if (path === "/categories") {
      return Promise.resolve({ items: [CATEGORY] }) as never;
    }
    if (path.startsWith("/expenses?")) {
      const page =
        routes.listPages[Math.min(listCalls, routes.listPages.length - 1)];
      listCalls += 1;
      return Promise.resolve(page) as never;
    }
    if (init?.method === "DELETE") {
      return routes.delete() as never;
    }
    return Promise.reject(
      new Error(`unexpected apiFetch: ${init?.method ?? "GET"} ${path}`),
    ) as never;
  });
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, ...render(<ExpensesPage />, { wrapper }) };
}

describe("ExpensesPage — delete", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    // `handleDelete` gates on window.confirm, and jsdom's is a stub that
    // returns undefined; without this, the mutation never fires at all.
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a failed delete is surfaced to the user, and the row stays", async () => {
    routeApi({
      listPages: [PAGE_WITH_EXPENSE],
      delete: () =>
        Promise.reject(
          new ApiError({
            code: "internal",
            message: SERVER_MESSAGE,
            status: 500,
          }),
        ),
    });
    const person = userEvent.setup();
    renderPage();

    await waitFor(() => expect(screen.getByText("Weekly shop")).toBeTruthy());

    await person.click(screen.getByRole("button", { name: "Delete" }));

    // The failure has to reach the screen. Anything less and the user walks
    // away believing the expense is gone.
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(SERVER_MESSAGE),
    );

    // And it has to say *which* expense, or it is unresolvable as soon as
    // there is more than one row.
    expect(screen.getByRole("alert").textContent).toContain("Weekly shop");

    // The row is still there — the delete did not happen, so the UI must not
    // look as though it did. Scoped to the table because the banner names
    // the same expense.
    expect(
      within(screen.getByRole("table")).getByText("Weekly shop"),
    ).toBeTruthy();
  });

  it("a successful delete invalidates the expenses query", async () => {
    routeApi({
      // The second list fetch is the one invalidation causes; it no longer
      // contains the deleted row.
      listPages: [PAGE_WITH_EXPENSE, EMPTY_PAGE],
      delete: () => Promise.resolve(undefined),
    });
    const person = userEvent.setup();
    renderPage();

    await waitFor(() => expect(screen.getByText("Weekly shop")).toBeTruthy());
    expect(listCalls).toBe(1);

    await person.click(screen.getByRole("button", { name: "Delete" }));

    // Invalidation is only observable as a refetch, and the refetch is what
    // takes the row off the screen — this mutation is not optimistic, so
    // nothing else would.
    await waitFor(() => expect(listCalls).toBe(2));
    await waitFor(() => expect(screen.queryByText("Weekly shop")).toBeNull());

    // No error banner on the happy path.
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
