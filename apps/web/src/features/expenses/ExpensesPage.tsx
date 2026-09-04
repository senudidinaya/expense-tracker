import { useEffect, useMemo, useRef, useState } from "react";
import type { CreateExpenseBody, Expense } from "@expense/shared";
import { ApiError } from "../../api/client";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { MoneyText } from "../../components/ui/MoneyText";
import { useCategories } from "../categories/useCategories";
import { ExpenseForm } from "./ExpenseForm";
import { ExpenseTable } from "./ExpenseTable";
import { FilterBar } from "./FilterBar";
import { filtersToSearchParams, type ExpenseFilters } from "./filters";
import {
  useCreateExpense,
  useDeleteExpense,
  useExpenses,
  useUpdateExpense,
} from "./useExpenses";

type PanelState =
  { mode: "closed" } | { mode: "create" } | { mode: "edit"; expense: Expense };

export function ExpensesPage() {
  const [filters, setFilters] = useState<ExpenseFilters>({});
  const [panel, setPanel] = useState<PanelState>({ mode: "closed" });

  const categoriesQuery = useCategories();
  const categories = categoriesQuery.data ?? [];
  const activeCategories = useMemo(
    () => categories.filter((c) => c.archivedAt === null),
    [categories],
  );
  const categoriesById = useMemo(
    () => new Map(categories.map((c) => [c.id, c])),
    [categories],
  );

  const expensesQuery = useExpenses(filters);
  const createExpense = useCreateExpense(filters);
  const updateExpense = useUpdateExpense(filters);
  const deleteExpense = useDeleteExpense();

  const pages = expensesQuery.data?.pages ?? [];
  const items = pages.flatMap((page) => page.items);
  const firstPage = pages[0];
  const isInitialLoad = expensesQuery.isPending;

  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !expensesQuery.hasNextPage) return;
    if (typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && !expensesQuery.isFetchingNextPage) {
        void expensesQuery.fetchNextPage();
      }
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [
    expensesQuery.hasNextPage,
    expensesQuery.isFetchingNextPage,
    expensesQuery,
  ]);

  async function handleCreate(body: CreateExpenseBody) {
    await createExpense.mutateAsync(body);
  }

  async function handleUpdate(body: CreateExpenseBody) {
    // An assertion, not a guard, and unreachable by construction:
    // `handleUpdate` is only ever handed to `ExpenseForm` in a render where
    // `panel.mode === "edit"`, and it closes over that render's `panel`, so
    // no interaction can arrive here. It throws rather than returning
    // because the `return` it replaces *resolved* — which closed the form as
    // though the save had happened, the one outcome a broken invariant must
    // not produce. Throwing lands in `ExpenseForm`'s catch and shows its
    // banner. Deliberately untested: reaching it would mean calling a
    // private function directly and asserting on that call rather than on
    // the app.
    if (panel.mode !== "edit") {
      throw new Error(
        "handleUpdate called while the panel was not in edit mode",
      );
    }
    await updateExpense.mutateAsync({ id: panel.expense.id, body });
  }

  function handleDelete(expense: Expense) {
    const ok = window.confirm(
      `Delete "${expense.description}"? This cannot be undone.`,
    );
    if (!ok) return;
    deleteExpense.mutate(expense.id);
  }

  /**
   * The expense whose delete failed, if it is still on screen.
   *
   * Not being optimistic keeps the row in place, which is right — but on its
   * own that is indistinguishable from never having clicked Delete, so the
   * failure has to be said out loud (BLOCKER 3). It is derived from `items`
   * rather than stored in state on purpose: naming the expense is what makes
   * the message unambiguous when several rows are on screen, and deriving it
   * means the message cannot outlive the row it names. If a later refetch
   * shows the expense gone — another session deleted it, or the error was a
   * lie and the write landed — the banner goes with it instead of insisting
   * a deletion failed for something that is no longer there.
   */
  const failedDelete =
    deleteExpense.isError && deleteExpense.variables !== undefined
      ? items.find((item) => item.id === deleteExpense.variables)
      : undefined;

  const exportHref = `/api/expenses/export.csv?${filtersToSearchParams(filters).toString()}`;
  const hasActiveFilters =
    filters.from !== undefined ||
    filters.to !== undefined ||
    (filters.categoryIds !== undefined && filters.categoryIds.length > 0) ||
    filters.q !== undefined;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-lg font-semibold text-text">Expenses</h1>
        <div className="flex items-center gap-2">
          <a
            href={exportHref}
            className="rounded-md border border-border-strong bg-surface px-4 py-2 text-sm font-medium text-text hover:bg-surface-hover"
          >
            Export CSV
          </a>
          <Button
            variant="primary"
            onClick={() => setPanel({ mode: "create" })}
          >
            Add expense
          </Button>
        </div>
      </div>

      <FilterBar
        filters={filters}
        onChange={setFilters}
        categories={categories}
      />

      {failedDelete ? (
        <p
          role="alert"
          className="rounded-md border border-danger bg-danger-subtle px-3 py-2 text-sm text-danger"
        >
          {`Couldn't delete "${failedDelete.description}". `}
          {deleteExpense.error instanceof ApiError
            ? deleteExpense.error.message
            : "Something went wrong. Please try again."}
        </p>
      ) : null}

      {firstPage && (firstPage.totalCount ?? 0) > 0 ? (
        <div className="flex items-center gap-2 text-sm text-muted">
          <span>{firstPage.totalCount} expenses</span>
          <span aria-hidden="true">·</span>
          <MoneyText
            amountMinor={firstPage.totalAmountMinor ?? 0}
            strong
            className="text-text"
          />
        </div>
      ) : null}

      {expensesQuery.isError ? (
        <EmptyState
          variant="error"
          title="Couldn't load expenses"
          description={
            expensesQuery.error instanceof ApiError
              ? expensesQuery.error.message
              : "Something went wrong. Please try again."
          }
          action={
            <Button onClick={() => void expensesQuery.refetch()}>Retry</Button>
          }
        />
      ) : !isInitialLoad && items.length === 0 ? (
        hasActiveFilters ? (
          <EmptyState
            title="No expenses match these filters"
            description="Try widening the date range or clearing a filter."
            action={
              <Button variant="secondary" onClick={() => setFilters({})}>
                Clear filters
              </Button>
            }
          />
        ) : (
          <EmptyState
            title="No expenses yet"
            description="Start tracking your spending — add your first expense."
            action={
              <Button
                variant="primary"
                onClick={() => setPanel({ mode: "create" })}
              >
                Add your first expense
              </Button>
            }
          />
        )
      ) : (
        <>
          <ExpenseTable
            items={items}
            categoriesById={categoriesById}
            loading={isInitialLoad}
            onEdit={(expense) => setPanel({ mode: "edit", expense })}
            onDelete={handleDelete}
          />
          <div ref={sentinelRef} className="h-1" />
          {expensesQuery.isFetchingNextPage ? (
            <p className="text-center text-sm text-muted">Loading more…</p>
          ) : null}
        </>
      )}

      <ExpenseForm
        open={panel.mode !== "closed"}
        onClose={() => setPanel({ mode: "closed" })}
        categories={activeCategories}
        expense={panel.mode === "edit" ? panel.expense : undefined}
        onSubmit={panel.mode === "edit" ? handleUpdate : handleCreate}
      />
    </div>
  );
}
