import type { Category, Expense } from "@expense/shared";
import { Button } from "../../components/ui/Button";
import { MoneyText } from "../../components/ui/MoneyText";
import { SkeletonRows } from "../../components/ui/Skeleton";
import {
  TBody,
  THead,
  TD,
  TFullRow,
  TH,
  TR,
  Table,
} from "../../components/ui/Table";

const COLUMN_COUNT = 5;

export interface ExpenseTableProps {
  items: Expense[];
  categoriesById: Map<string, Category>;
  loading: boolean;
  onEdit: (expense: Expense) => void;
  onDelete: (expense: Expense) => void;
}

/**
 * The dense expenses table: date, category, description with a notes
 * indicator, right-aligned tabular amount, row actions.
 *
 * Skeleton rows render inside this real `tbody` rather than replacing it, so
 * the column widths during loading are the ones the data will get — nothing
 * jumps once the first page arrives.
 */
export function ExpenseTable({
  items,
  categoriesById,
  loading,
  onEdit,
  onDelete,
}: ExpenseTableProps) {
  return (
    <Table>
      <THead>
        <TR>
          <TH>Date</TH>
          <TH>Category</TH>
          <TH>Description</TH>
          <TH numeric>Amount</TH>
          <TH>
            <span className="sr-only">Actions</span>
          </TH>
        </TR>
      </THead>
      <TBody>
        {loading ? (
          <SkeletonRows rows={8} columns={COLUMN_COUNT} numericColumns={[3]} />
        ) : items.length === 0 ? (
          <TFullRow
            colSpan={COLUMN_COUNT}
            className="text-center text-sm text-muted"
          >
            No expenses match these filters.
          </TFullRow>
        ) : (
          items.map((item) => (
            <TR key={item.id}>
              <TD>{item.date}</TD>
              <TD>{categoriesById.get(item.categoryId)?.name ?? "—"}</TD>
              <TD>
                <span className="inline-flex items-center gap-1.5">
                  {item.description}
                  {item.notes ? (
                    <span
                      aria-label="Has notes"
                      title={item.notes}
                      className="size-1.5 shrink-0 rounded-full bg-accent"
                    />
                  ) : null}
                </span>
              </TD>
              <TD numeric>
                <MoneyText amountMinor={item.amountMinor} />
              </TD>
              <TD>
                <div className="flex justify-end gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onEdit(item)}
                  >
                    Edit
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => onDelete(item)}
                  >
                    Delete
                  </Button>
                </div>
              </TD>
            </TR>
          ))
        )}
      </TBody>
    </Table>
  );
}
