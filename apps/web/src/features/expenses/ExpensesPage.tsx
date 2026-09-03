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
    if (panel.mode !== "edit") return;
    await updateExpense.mutateAsync({ id: panel.expense.id, body });
  }

  function handleDelete(expense: Expense) {
    const ok = window.confirm(
      `Delete "${expense.description}"? This cannot be undone.`,
    );
    if (!ok) return;
    deleteExpense.mutate(expense.id);
  }

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
