/**
 * Filter state for the expenses list, as the page keeps it.
 *
 * Mirrors `expenseFiltersQuery` from `@expense/shared` plus `limit` — the one
 * field that query has but the CSV export's `exportExpensesQuery` does not.
 * That asymmetry is why the serializer below, not either schema, is the
 * source of truth for turning this into a query string.
 */
export interface ExpenseFilters {
  from?: string | undefined;
  to?: string | undefined;
  categoryIds?: string[] | undefined;
  q?: string | undefined;
  limit?: number | undefined;
}

/**
 * The single serializer from filter state to list query params.
 *
 * Used by both `useExpenses` (which appends `cursor`) and the CSV-export
 * anchor (which does not) — if the export built its own query string, the
 * downloaded file could silently contain different rows than the table on
 * screen. `exportExpensesQuery` strips unknown keys, so `limit` riding along
 * on an export URL is harmless.
 */
export function filtersToSearchParams(
  filters: ExpenseFilters,
): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.categoryIds && filters.categoryIds.length > 0) {
    params.set("categoryIds", filters.categoryIds.join(","));
  }
  if (filters.q) params.set("q", filters.q);
  if (filters.limit !== undefined) params.set("limit", String(filters.limit));
  return params;
}
