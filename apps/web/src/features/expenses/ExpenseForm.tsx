import { useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
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
import { formatMinorForInput, parseRupeesToMinor } from "../../lib/money";

export interface ExpenseFormProps {
  open: boolean;
  onClose: () => void;
  /** Active categories only — an archived one is not a legal choice here (the API returns 400). */
  categories: Category[];
  /** `undefined` for add; the expense being changed for edit. */
  expense?: Expense;
  onSubmit: (body: CreateExpenseBody) => Promise<void>;
}

/**
 * The RHF form's own shape — not `CreateExpenseBody`. `amountRupees` is a
 * string because that's what a text field holds; converting it to the
 * integer minor units the API wants happens once, explicitly, in the submit
 * handler, never by `reset()` writing minor units into a field that
 * elsewhere reads its own display value as rupees (Task 20 BLOCKER 1).
 *
 * The non-amount fields reuse `createExpenseBody`'s own field schemas so the
 * validation rules (max lengths, the 1-year-ahead date cap) live in exactly
 * one place. `amountRupees` is the one field that cannot: it validates in two
 * steps, because rupee *syntax* and "an expense costs more than nothing" are
 * different rules owned by different layers. `parseRupeesToMinor` answers the
 * first; `amountMinor.positive()` in @expense/shared owns the second, and this
 * is where that rule reaches the user as a field error rather than as a thrown
 * parse failure.
 */
const expenseFormSchema = z.object({
  amountRupees: z.string().superRefine((value, ctx) => {
    let amountMinor: number;
    try {
      amountMinor = parseRupeesToMinor(value);
    } catch (caught) {
      ctx.addIssue({
        code: "custom",
        message: caught instanceof Error ? caught.message : "Invalid amount",
      });
      return;
    }

    if (amountMinor <= 0) {
      ctx.addIssue({
        code: "custom",
        message: "Amount must be more than Rs 0.00",
      });
    }
  }),
  categoryId: createExpenseBody.shape.categoryId,
  date: createExpenseBody.shape.date,
  description: createExpenseBody.shape.description,
  notes: createExpenseBody.shape.notes,
});

type ExpenseFormValues = z.infer<typeof expenseFormSchema>;

function defaultsFor(expense: Expense | undefined): ExpenseFormValues {
  return {
    amountRupees: formatMinorForInput(expense?.amountMinor ?? 0),
    categoryId: expense?.categoryId ?? "",
    date: expense?.date ?? todayIsoDate(),
    description: expense?.description ?? "",
    notes: expense?.notes ?? undefined,
  };
}

/**
 * Add/edit slide-over. The form validates against `expenseFormSchema`
 * (above); the submit handler converts `amountRupees` to `amountMinor` and
 * re-parses the result through the shared `createExpenseBody` so that schema
 * stays the last client-side gate before `onSubmit`, exactly as it is for
 * every other field.
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
  } = useForm<ExpenseFormValues>({
    resolver: zodResolver(expenseFormSchema),
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
      // DELIBERATELY UNTESTED, AND DELIBERATELY UNREACHABLE TODAY. Deleting
      // this `.parse` turns no test red (it was mutation-tested: M3), so it
      // will look like dead code to the next reader. It is not — it is an
      // assertion boundary, and its threat model is future change, not
      // present input:
      //
      //   - `parseRupeesToMinor` regresses (starts rounding, returns a float,
      //     returns a negative) and `amountMinor`'s `.int().positive()`
      //     catches it here instead of the API catching it as a 400 — or
      //     worse, than nobody catching a wrong-but-valid amount.
      //   - a required field is added to `createExpenseBody` that this form
      //     does not set. The object literal below would still typecheck via
      //     inference in some shapes; the parse fails loudly either way.
      //
      // Testing it would mean stubbing `parseRupeesToMinor` to lie, which
      // asserts on the stub rather than on the form. The cost of keeping it
      // is one function call per submit; the cost of removing it is a silent
      // bad write. Keep it.
      const body = createExpenseBody.parse({
        amountMinor: parseRupeesToMinor(values.amountRupees),
        categoryId: values.categoryId,
        date: values.date,
        description: values.description,
        notes: values.notes,
      });
      await onSubmit(body);
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
          type="text"
          inputMode="decimal"
          {...register("amountRupees")}
          error={errors.amountRupees?.message}
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
