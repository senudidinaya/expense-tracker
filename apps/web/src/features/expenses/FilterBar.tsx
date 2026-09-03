import { useEffect, useId, useState } from "react";
import type { Category } from "@expense/shared";
import { DateRangePicker } from "../../components/ui/DateRangePicker";
import { cn } from "../../lib/cn";
import type { ExpenseFilters } from "./filters";

const SEARCH_DEBOUNCE_MS = 300;

export interface FilterBarProps {
  filters: ExpenseFilters;
  onChange: (next: ExpenseFilters) => void;
  categories: Category[];
}

/**
 * Date range, category multi-select (archived categories included — old
 * spending was still filed under them), and a search box.
 *
 * The search box keeps its own local state and only pushes `q` up to the
 * parent 300ms after the last keystroke, so every character typed does not
 * turn into a request; the date and category controls are simple enough that
 * they update `filters` immediately.
 */
export function FilterBar({ filters, onChange, categories }: FilterBarProps) {
  const searchId = useId();
  const [searchInput, setSearchInput] = useState(filters.q ?? "");

  useEffect(() => {
    const handle = setTimeout(() => {
      onChange({ ...filters, q: searchInput || undefined });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
    // Deliberately keyed on `searchInput` alone: re-running when `filters` or
    // `onChange` changes (not just `searchInput`) would fire a debounce cycle
    // for every date/category change too; this effect owns only the search
    // box's contribution to `filters`.
  }, [searchInput]);

  const selectedIds = new Set(filters.categoryIds ?? []);

  function toggleCategory(id: string) {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    const categoryIds = [...next];
    onChange({
      ...filters,
      categoryIds: categoryIds.length > 0 ? categoryIds : undefined,
    });
  }

  return (
    <div className="flex flex-wrap items-end gap-4">
      <DateRangePicker
        value={{ from: filters.from ?? null, to: filters.to ?? null }}
        onChange={(range) =>
          onChange({
            ...filters,
            from: range.from ?? undefined,
            to: range.to ?? undefined,
          })
        }
      />

      <details className="relative">
        <summary
          className={cn(
            "cursor-pointer list-none rounded-md border border-border-strong bg-surface",
            "px-3 py-2 text-sm text-text hover:bg-surface-hover",
          )}
        >
          Categories
          {selectedIds.size > 0 ? ` (${String(selectedIds.size)})` : ""}
        </summary>
        <div
          className={cn(
            "absolute z-10 mt-2 flex max-h-64 w-56 flex-col gap-1 overflow-y-auto",
            "rounded-lg border border-border bg-surface p-2 shadow-panel",
          )}
        >
          {categories.length === 0 ? (
            <p className="px-2 py-1 text-xs text-muted">No categories yet</p>
          ) : (
            categories.map((category) => (
              <label
                key={category.id}
                className="flex items-center gap-2 rounded-md px-2 py-1 text-sm text-text hover:bg-surface-hover"
              >
                <input
                  type="checkbox"
                  checked={selectedIds.has(category.id)}
                  onChange={() => toggleCategory(category.id)}
                />
                {category.name}
                {category.archivedAt !== null ? (
                  <span className="text-xs text-muted">(archived)</span>
                ) : null}
              </label>
            ))
          )}
        </div>
      </details>

      <div className="flex flex-col gap-1">
        <label htmlFor={searchId} className="text-xs font-medium text-muted">
          Search
        </label>
        <input
          id={searchId}
          type="search"
          placeholder="Description…"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          className="w-56 rounded-md border border-border-strong bg-surface px-3 py-2 text-sm text-text placeholder:text-faint"
        />
      </div>
    </div>
  );
}
