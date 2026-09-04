import { useEffect, useId, useRef, useState } from "react";
import type { Category } from "@expense/shared";
import { DateRangePicker } from "../../components/ui/DateRangePicker";
import { cn } from "../../lib/cn";
import type { ExpenseFilters } from "./filters";

const SEARCH_DEBOUNCE_MS = 300;

export interface FilterBarProps {
  filters: ExpenseFilters;
  /**
   * Accepts a functional updater as well as a plain object, and every control
   * in here uses the updater form — see the component comment. `ExpensesPage`
   * passes `setFilters` straight in, which already supports both.
   */
  onChange: (
    next: ExpenseFilters | ((prev: ExpenseFilters) => ExpenseFilters),
  ) => void;
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
 *
 * Every control writes through a functional updater, and none of them reads
 * `filters` at write time. That is not a style preference — it is the fix for
 * Task 20 BLOCKER 2. Each control owns exactly one part of the filter object
 * (`q`, `from`/`to`, `categoryIds`), so reading the whole object to spread it
 * makes a control's write depend on a value it does not own. For the search
 * box that dependency was actively wrong: its `setTimeout` closed over the
 * `filters` from the render that armed it, and because the effect is keyed on
 * `searchInput` alone, a date or category change in the intervening 300ms
 * never cleared that timer — so the timer fired and wrote a filter object
 * that predated the other control's change, silently undoing it. The updater
 * form means the debounce can only ever say "whatever the filters are when
 * this lands, with this `q`", which is all it ever knew.
 */
export function FilterBar({ filters, onChange, categories }: FilterBarProps) {
  const searchId = useId();
  const [searchInput, setSearchInput] = useState(filters.q ?? "");

  // What the debounce last pushed. Mounting is not a filter change, so
  // without this the effect's first run replaces `{}` with a fresh `{}` —
  // a new object identity, which downstream is a new query key and a refetch
  // for nothing. Tracking the value rather than a `didMount` boolean also
  // survives StrictMode's double-invoked effects (`main.tsx` renders under
  // it), where a boolean is already `true` by the second invocation and the
  // guard it was supposed to provide is gone.
  const lastPushed = useRef(searchInput);

  useEffect(() => {
    if (lastPushed.current === searchInput) return;

    const handle = setTimeout(() => {
      lastPushed.current = searchInput;
      onChange((prev) => ({ ...prev, q: searchInput || undefined }));
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
    // Keyed on `searchInput` alone. `filters` is deliberately absent — the
    // updater above means this effect no longer reads it, so there is nothing
    // to go stale. `onChange` is absent too: an unstable `onChange` identity
    // would re-arm the timer on every render, and since each firing changes
    // the parent's state (and so its identity again), that is an endless
    // 300ms update loop rather than a debounce.
  }, [searchInput]);

  const selectedIds = new Set(filters.categoryIds ?? []);

  function toggleCategory(id: string) {
    onChange((prev) => {
      const next = new Set(prev.categoryIds ?? []);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      const categoryIds = [...next];
      return {
        ...prev,
        categoryIds: categoryIds.length > 0 ? categoryIds : undefined,
      };
    });
  }

  return (
    <div className="flex flex-wrap items-end gap-4">
      <DateRangePicker
        value={{ from: filters.from ?? null, to: filters.to ?? null }}
        onChange={(range) =>
          onChange((prev) => ({
            ...prev,
            from: range.from ?? undefined,
            to: range.to ?? undefined,
          }))
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
