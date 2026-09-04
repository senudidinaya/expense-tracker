import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import {
  expenseResponse,
  listExpensesResponse,
  type CreateExpenseBody,
  type Expense,
  type ListExpensesResponse,
  type PatchExpenseBody,
} from "@expense/shared";
import { apiFetch, noContent } from "../../api/client";
import { filtersToSearchParams, type ExpenseFilters } from "./filters";

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

/**
 * Placeholder id for a row that only exists in the optimistic cache so far.
 *
 * The prefix is load-bearing rather than cosmetic. An optimistic row has no
 * server-side identity yet, so every route that takes an expense id —
 * `PATCH /expenses/:id`, `DELETE /expenses/:id` — will reject it: `idParams`
 * is `uuid`, so "optimistic-0" is a 400 before any handler runs. That makes
 * the prefix the one available signal that a row's actions cannot work yet,
 * and `isOptimisticExpense` the single reader of it. Minting and detection
 * live side by side on purpose: they are one convention, and splitting them
 * is how the two drift apart.
 */
const OPTIMISTIC_ID_PREFIX = "optimistic-";
let optimisticSeq = 0;

function nextOptimisticId(): string {
  return `${OPTIMISTIC_ID_PREFIX}${String(optimisticSeq++)}`;
}

/**
 * True while this row exists only in the cache, awaiting the POST's response.
 *
 * Callers rendering row actions must disable them for such a row: an Edit that
 * opens the form and then PATCHes "optimistic-0" is a guaranteed 400 shown to
 * a user who did nothing wrong, and a Delete is the same.
 */
export function isOptimisticExpense(expense: Expense): boolean {
  return expense.id.startsWith(OPTIMISTIC_ID_PREFIX);
}

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
        id: nextOptimisticId(),
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
 *
 * That is only half the contract, and the only half this hook can keep.
 * Leaving the row in place stops the UI lying about *state*, but it says
 * nothing about the *action*: a delete that failed and a delete that was
 * never attempted look identical on screen, so an unread `isError` reads as
 * success — which is exactly how Task 20 BLOCKER 3 shipped, under this
 * docstring's own reasoning. **Every caller must render `isError`/`error`.**
 * `ExpensesPage` renders it as a banner naming the expense, kept alive only
 * while that row is still loaded (see `ExpensesPage.test.tsx`).
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
