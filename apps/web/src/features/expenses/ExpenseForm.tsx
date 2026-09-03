import { useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import {
  createExpenseBody,
  todayIsoDate,
  type Category,
  type CreateExpenseBody,
  type Expense,
} from "@expense/shared";
import { ApiError } from "../../api/client";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { Select } from "../../components/ui/Select";
import { SlideOver } from "../../components/ui/SlideOver";

export interface ExpenseFormProps {
  open: boolean;
  onClose: () => void;
  /** Active categories only — an archived one is not a legal choice here (the API returns 400). */
  categories: Category[];
  /** `undefined` for add; the expense being changed for edit. */
  expense?: Expense;
  onSubmit: (body: CreateExpenseBody) => Promise<void>;
}

function defaultsFor(expense: Expense | undefined): CreateExpenseBody {
  return {
    amountMinor: expense?.amountMinor ?? 0,
    categoryId: expense?.categoryId ?? "",
    date: expense?.date ?? todayIsoDate(),
    description: expense?.description ?? "",
    notes: expense?.notes ?? undefined,
  };
}

/**
 * Add/edit slide-over, resolved against the shared `createExpenseBody` — the
 * same schema the API validates the request body with. Edit sends a full
 * object too: `patchExpenseBody` is `createExpenseBody.partial()`, so a
 * complete body already satisfies it.
 *
 * The amount field is the one place the form's display and the schema's
 * value differ: people type rupees, the schema wants integer minor units.
 * `setValueAs` does that conversion at the point of registration, so the
 * resolver is still validating the real `amountMinor` — nothing downstream
 * of react-hook-form ever sees a rupee figure.
 */
export function ExpenseForm({
  open,
  onClose,
  categories,
  expense,
  onSubmit,
}: ExpenseFormProps) {
  const isEdit = expense !== undefined;
  const [banner, setBanner] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CreateExpenseBody>({
    resolver: zodResolver(createExpenseBody),
    defaultValues: defaultsFor(expense),
  });

  // The same panel instance is reused across "Add" and "Edit <row>" clicks
  // (`ExpensesPage` keeps one `ExpenseForm` mounted), so switching targets
  // has to re-seed the form explicitly rather than rely on mount-time
  // defaults.
  useEffect(() => {
    if (open) {
      setBanner(null);
      reset(defaultsFor(expense));
    }
  }, [open, expense, reset]);

  const submit = handleSubmit(async (values) => {
    setBanner(null);
    try {
      await onSubmit(values);
      onClose();
    } catch (caught) {
      setBanner(
        caught instanceof ApiError
          ? caught.message
          : "Could not save this expense. Try again.",
      );
    }
  });

  return (
    <SlideOver
      open={open}
      onClose={onClose}
      title={isEdit ? "Edit expense" : "Add expense"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="expense-form"
            variant="primary"
            loading={isSubmitting}
          >
            {isEdit ? "Save changes" : "Add expense"}
          </Button>
        </>
      }
    >
      {banner ? (
        <p
          role="alert"
          className="mb-4 rounded-md border border-danger bg-danger-subtle px-3 py-2 text-sm text-danger"
        >
          {banner}
        </p>
      ) : null}

      <form
        id="expense-form"
        noValidate
        onSubmit={(event) => void submit(event)}
        className="flex flex-col gap-4"
      >
        <Input
          label="Amount"
          prefix="Rs"
          type="number"
          step="0.01"
          min="0.01"
          inputMode="decimal"
          defaultValue={
            expense ? (expense.amountMinor / 100).toFixed(2) : undefined
          }
          {...register("amountMinor", {
            setValueAs: (value: string) =>
              value === "" ? Number.NaN : Math.round(Number(value) * 100),
          })}
          error={errors.amountMinor?.message}
          required
        />

        <Select
          label="Category"
          placeholder="Choose a category"
          {...register("categoryId")}
          error={errors.categoryId?.message}
          required
        >
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </Select>

        <Input
          label="Date"
          type="date"
          {...register("date")}
          error={errors.date?.message}
          required
        />

        <Input
          label="Description"
          {...register("description")}
          error={errors.description?.message}
          required
        />

        <Input
          label="Notes"
          hint="Optional"
          {...register("notes")}
          error={errors.notes?.message}
        />
      </form>
    </SlideOver>
  );
}
