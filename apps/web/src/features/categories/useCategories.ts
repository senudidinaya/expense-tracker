import { useQuery } from "@tanstack/react-query";
import { categoriesResponse } from "@expense/shared";
import { apiFetch } from "../../api/client";

/**
 * Every category, active and archived alike — the shape `GET /categories`
 * always returns. Callers that only want active categories (the expense
 * form's dropdown) filter on `archivedAt` themselves; callers that want both
 * (the filter bar) do not have to ask twice.
 */
export function useCategories() {
  return useQuery({
    queryKey: ["categories"],
    queryFn: () =>
      apiFetch(categoriesResponse, "/categories").then((r) => r.items),
  });
}
