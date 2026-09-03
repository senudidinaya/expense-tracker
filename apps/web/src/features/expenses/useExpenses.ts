import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import { z } from "zod";
import {
  expenseDto,
  listExpensesResponse,
  type CreateExpenseBody,
  type Expense,
  type ListExpensesResponse,
  type PatchExpenseBody,
} from "@expense/shared";
import { apiFetch, noContent } from "../../api/client";
import { filtersToSearchParams, type ExpenseFilters } from "./filters";

const expenseResponse = z.object({ expense: expenseDto });

/** The query key every expenses query and mutation targets, given the filters shown on screen. */
export function expensesQueryKey(filters: ExpenseFilters) {
  return ["expenses", filters] as const;
}

/**
 * The expenses list, keyset-paginated. `pageParam` is the opaque cursor the
 * API handed back as `nextCursor` — `null` asks for the first page, which is
 * also the only page carrying totals.
 */
export function useExpenses(filters: ExpenseFilters) {
  return useInfiniteQuery({
    queryKey: expensesQueryKey(filters),
    queryFn: async ({ pageParam }) => {
      const params = filtersToSearchParams(filters);
      if (pageParam !== null) params.set("cursor", pageParam);
      return apiFetch(listExpensesResponse, `/expenses?${params.toString()}`);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
  });
}

type ExpensesData = InfiniteData<ListExpensesResponse, string | null>;

function insertIntoFirstPage(
  data: ExpensesData | undefined,
  expense: Expense,
): ExpensesData | undefined {
  const firstPage = data?.pages[0];
  if (!data || !firstPage) return data;
  return {
    ...data,
    pages: [
      { ...firstPage, items: [expense, ...firstPage.items] },
      ...data.pages.slice(1),
    ],
  };
}

function replaceInPages(
  data: ExpensesData | undefined,
  id: string,
  patch: Partial<Expense>,
): ExpensesData | undefined {
  if (!data) return data;
  const updatedAt = new Date().toISOString();
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      items: page.items.map((item) =>
        item.id === id ? { ...item, ...patch, updatedAt } : item,
      ),
    })),
  };
}

/** Placeholder id for a row that only exists in the optimistic cache so far. */
let optimisticSeq = 0;

/**
 * Optimistic create: the new row lands in the first page of the cache before
 * the request is even sent, and comes back out if the server rejects it.
 *
 * DECIDED (Task 20 mutation semantics): unlike delete, a failed create leaves
 * nothing behind but a row that should not exist — safe to remove without
 * asking the user to re-confirm anything.
 */
export function useCreateExpense(filters: ExpenseFilters) {
  const queryClient = useQueryClient();
  const queryKey = expensesQueryKey(filters);

  return useMutation({
    mutationFn: (body: CreateExpenseBody) =>
      apiFetch(expenseResponse, "/expenses", {
        method: "POST",
        body: JSON.stringify(body),
      }).then((result) => result.expense),
    onMutate: async (body) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<ExpensesData>(queryKey);

      const now = new Date().toISOString();
      const optimistic: Expense = {
        id: `optimistic-${String(optimisticSeq++)}`,
        categoryId: body.categoryId,
        recurringRuleId: null,
        amountMinor: body.amountMinor,
        currency: "LKR",
        date: body.date,
        description: body.description,
        notes: body.notes ?? null,
        createdAt: now,
        updatedAt: now,
      };

      queryClient.setQueryData<ExpensesData>(queryKey, (data) =>
        insertIntoFirstPage(data, optimistic),
      );

      return { previous };
    },
    onError: (_error, _body, context) => {
      queryClient.setQueryData(queryKey, context?.previous);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["expenses"] });
    },
  });
}

/**
 * Optimistic update: the edited row is patched in place across every loaded
 * page (it may not be on the first one), and restored to its previous
 * contents if the server rejects it.
 */
export function useUpdateExpense(filters: ExpenseFilters) {
  const queryClient = useQueryClient();
  const queryKey = expensesQueryKey(filters);

  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: PatchExpenseBody }) =>
      apiFetch(expenseResponse, `/expenses/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }).then((result) => result.expense),
    onMutate: async ({ id, body }) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<ExpensesData>(queryKey);

      queryClient.setQueryData<ExpensesData>(queryKey, (data) =>
        replaceInPages(data, id, body),
      );

      return { previous };
    },
    onError: (_error, _vars, context) => {
      queryClient.setQueryData(queryKey, context?.previous);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["expenses"] });
    },
  });
}

/**
 * Delete — deliberately NOT optimistic (Task 20 mutation semantics).
 *
 * A failed create leaves a row that should not exist and can simply be
 * removed; a failed delete means a row the user believed was gone is back —
 * and if they have already moved on, they never learn it failed. So the row
 * stays on screen, unmutated, until the server confirms it is gone.
 */
export function useDeleteExpense() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      apiFetch(noContent, `/expenses/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["expenses"] });
    },
  });
}
