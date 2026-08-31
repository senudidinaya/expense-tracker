/**
 * TEMPORARY — DELETE IN TASK 18.
 *
 * The eyeball surface for Task 17 (plan.md Step 3): every UI primitive in every
 * state, in both themes, on one page. It exists so the token layer and the kit
 * can be reviewed before any real screen depends on them.
 *
 * Task 18 introduces the router and the real app shell. When it does, delete
 * this file, the `src/kitchen/` directory, and the `/_kitchen` branch in
 * App.tsx. Nothing outside this directory imports it.
 */
import { useState, type ReactNode } from "react";
import { Button } from "../components/ui/Button";
import {
  DateRangePicker,
  type DateRange,
} from "../components/ui/DateRangePicker";
import { EmptyState } from "../components/ui/EmptyState";
import { Input } from "../components/ui/Input";
import { MoneyText } from "../components/ui/MoneyText";
import { Select } from "../components/ui/Select";
import { Skeleton, SkeletonRows } from "../components/ui/Skeleton";
import { SlideOver } from "../components/ui/SlideOver";
import {
  Table,
  TBody,
  TD,
  TFullRow,
  TH,
  THead,
  TR,
} from "../components/ui/Table";

type Theme = "light" | "dark";

export function KitchenSink() {
  const [theme, setTheme] = useState<Theme>("light");
  const [slideOverOpen, setSlideOverOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [range, setRange] = useState<DateRange>({
    from: "2026-08-01",
    to: "2026-08-28",
  });
  const [invertedRange, setInvertedRange] = useState<DateRange>({
    from: "2026-08-28",
    to: "2026-08-01",
  });

  function toggleTheme() {
    const next: Theme = theme === "light" ? "dark" : "light";
    setTheme(next);
    // Light is the default, so the attribute is only ever set for dark.
    if (next === "dark")
      document.documentElement.setAttribute("data-theme", "dark");
    else document.documentElement.removeAttribute("data-theme");
  }

  return (
    <div className="min-h-screen bg-bg px-6 py-8">
      <div className="mx-auto flex max-w-page flex-col">
        <header className="flex items-start justify-between gap-4 pb-4">
          <div className="flex flex-col gap-1">
            <h1 className="text-2xl font-semibold text-text">UI kit</h1>
            <p className="text-sm text-muted">
              Temporary review page for Task 17. Deleted in Task 18.
            </p>
          </div>
          <Button onClick={toggleTheme}>
            {theme === "light" ? "Dark theme" : "Light theme"}
          </Button>
        </header>

        <Section title="Type scale" caption="Four sizes. Nothing else exists.">
          <div className="flex flex-col gap-2">
            <p className="text-2xl font-semibold text-text">
              24px — page title
            </p>
            <p className="text-lg font-semibold text-text">
              18px — section title
            </p>
            <p className="text-sm text-text">
              14px — body, table cells, inputs, buttons
            </p>
            <p className="text-xs text-muted">
              12px — column headers, labels, meta
            </p>
          </div>
        </Section>

        <Section
          title="Palette"
          caption="Structural roles. Toggle the theme; every swatch re-resolves."
        >
          <div className="flex flex-wrap gap-3">
            <Swatch name="bg" className="bg-bg" />
            <Swatch name="surface" className="bg-surface" />
            <Swatch name="surface-hover" className="bg-surface-hover" />
            <Swatch name="border" className="bg-border" />
            <Swatch name="border-strong" className="bg-border-strong" />
            <Swatch name="text" className="bg-text" />
            <Swatch name="muted" className="bg-muted" />
            <Swatch name="surface-active" className="bg-surface-active" />
            <Swatch name="accent" className="bg-accent" />
            <Swatch name="accent-hover" className="bg-accent-hover" />
            <Swatch name="accent-subtle" className="bg-accent-subtle" />
            <Swatch name="danger" className="bg-danger" />
            <Swatch name="danger-solid" className="bg-danger-solid" />
            <Swatch name="success" className="bg-success" />
          </div>
        </Section>

        <Section
          title="Button"
          caption="Four variants, two sizes, every state."
        >
          <div className="flex flex-col gap-4">
            <Row label="Default">
              <Button variant="primary">Add expense</Button>
              <Button variant="secondary">Cancel</Button>
              <Button variant="ghost">Clear filters</Button>
              <Button variant="danger">Delete</Button>
            </Row>
            <Row label="Destructive">
              <Button variant="danger">Delete expense</Button>
              <Button variant="danger-confirm">Yes, delete it</Button>
              <span className="text-xs text-muted">
                outlined in the list; filled only at the confirm step
              </span>
            </Row>
            <Row label="Hover (hover them)">
              <Button variant="primary">Add expense</Button>
              <Button variant="secondary">Cancel</Button>
              <Button variant="ghost">Clear filters</Button>
              <Button variant="danger">Delete</Button>
            </Row>
            <Row label="Disabled">
              <Button variant="primary" disabled>
                Add expense
              </Button>
              <Button variant="secondary" disabled>
                Cancel
              </Button>
              <Button variant="ghost" disabled>
                Clear filters
              </Button>
              <Button variant="danger" disabled>
                Delete
              </Button>
              <Button variant="danger-confirm" disabled>
                Yes, delete it
              </Button>
              <span className="text-xs text-muted">
                filled variants go neutral grey, not a faded tint of their own
                colour
              </span>
            </Row>
            <Row label="Loading">
              <Button variant="primary" loading>
                Saving
              </Button>
              <Button variant="secondary" loading>
                Exporting
              </Button>
              <Button variant="danger-confirm" loading>
                Deleting
              </Button>
              <span className="text-xs text-muted">
                full colour + spinner — compare with the dimmed row above
              </span>
            </Row>
            <Row label="Small / with icon">
              <Button size="sm" variant="primary">
                Save
              </Button>
              <Button size="sm" variant="secondary">
                Edit
              </Button>
              <Button variant="secondary" icon={<PlusIcon />}>
                New category
              </Button>
            </Row>
          </div>
        </Section>

        <Section title="Input" caption="Label, hint, error, prefix, disabled.">
          <div className="grid gap-4 sm:grid-cols-2">
            <Input
              label="Description"
              placeholder="Lunch at Barista"
              required
            />
            <Input
              label="Amount"
              prefix="Rs"
              inputMode="decimal"
              placeholder="0.00"
              hint="Two decimal places. Stored as integer cents."
            />
            <Input
              label="Email"
              type="email"
              defaultValue="not-an-email"
              error="Enter a valid email address."
            />
            <Input
              label="Created"
              defaultValue="2026-08-28"
              disabled
              hint="Set by the server."
            />
          </div>
        </Section>

        <Section title="Select" caption="Native control, styled.">
          <div className="grid gap-4 sm:grid-cols-2">
            <Select label="Category" defaultValue="groceries">
              <option value="groceries">Groceries</option>
              <option value="transport">Transport</option>
              <option value="utilities">Utilities</option>
            </Select>
            <Select
              label="Category"
              placeholder="Choose a category"
              defaultValue=""
            >
              <option value="groceries">Groceries</option>
              <option value="transport">Transport</option>
            </Select>
            <Select label="Category" defaultValue="" error="Pick a category.">
              <option value="">—</option>
              <option value="groceries">Groceries</option>
            </Select>
            <Select
              label="Currency"
              defaultValue="LKR"
              disabled
              hint="LKR only."
            >
              <option value="LKR">LKR — Sri Lankan rupee</option>
            </Select>
          </div>
        </Section>

        <Section
          title="MoneyText"
          caption="formatLKR is the only formatter. Every figure is tabular — the column below lines up digit for digit."
        >
          <div className="flex flex-col items-start gap-1">
            <MoneyText amountMinor={5} />
            <MoneyText amountMinor={125000} />
            <MoneyText amountMinor={100000000} />
            <MoneyText amountMinor={0} tone="muted" />
            <MoneyText amountMinor={-125000} tone="negative" />
            <MoneyText amountMinor={125000} tone="positive" />
            <MoneyText amountMinor={9876543} strong />
          </div>
        </Section>

        <Section
          title="DateRangePicker"
          caption="Two native inputs plus the ranges people pick."
        >
          <div className="flex flex-col gap-6">
            <DateRangePicker
              value={range}
              onChange={setRange}
              today={new Date(2026, 7, 28)}
              showLegend
            />
            <DateRangePicker
              value={invertedRange}
              onChange={setInvertedRange}
              legend="Error state"
              showLegend
              today={new Date(2026, 7, 28)}
            />
            <DateRangePicker
              value={{ from: null, to: null }}
              onChange={() => {}}
              legend="Disabled"
              showLegend
              disabled
            />
          </div>
        </Section>

        <Section
          title="Table"
          caption="Dense, with a numeric column and a totals row."
        >
          <Table>
            <THead>
              <TR>
                <TH>Date</TH>
                <TH>Category</TH>
                <TH>Description</TH>
                <TH numeric>Amount</TH>
              </TR>
            </THead>
            <TBody>
              <TR interactive>
                <TD>2026-08-28</TD>
                <TD>Groceries</TD>
                <TD>Keells weekly shop</TD>
                <TD numeric>
                  <MoneyText amountMinor={1234550} />
                </TD>
              </TR>
              <TR interactive selected>
                <TD>2026-08-27</TD>
                <TD>Transport</TD>
                <TD>Airport taxi</TD>
                <TD numeric>
                  <MoneyText amountMinor={850000} />
                </TD>
              </TR>
              <TR interactive>
                <TD>2026-08-26</TD>
                <TD>Utilities</TD>
                <TD>CEB electricity</TD>
                <TD numeric>
                  <MoneyText amountMinor={5} />
                </TD>
              </TR>
              <TR>
                <TD colSpan={3} className="font-medium">
                  Total
                </TD>
                <TD numeric>
                  <MoneyText amountMinor={2084555} strong />
                </TD>
              </TR>
            </TBody>
          </Table>
        </Section>

        <Section
          title="Table — loading"
          caption="Skeleton rows inside the real tbody, so columns do not jump."
        >
          <Table>
            <THead>
              <TR>
                <TH>Date</TH>
                <TH>Category</TH>
                <TH>Description</TH>
                <TH numeric>Amount</TH>
              </TR>
            </THead>
            <TBody>
              <SkeletonRows rows={4} columns={4} numericColumns={[3]} />
            </TBody>
          </Table>
        </Section>

        <Section
          title="Table — empty"
          caption="Empty and error states live inside the frame."
        >
          <div className="flex flex-col gap-6">
            <Table>
              <THead>
                <TR>
                  <TH>Date</TH>
                  <TH>Category</TH>
                  <TH numeric>Amount</TH>
                </TR>
              </THead>
              <TBody>
                <TFullRow colSpan={3}>
                  <EmptyState
                    icon={<PlusIcon />}
                    title="No expenses yet"
                    description="Add your first expense and it will show up here."
                    action={<Button variant="primary">Add expense</Button>}
                  />
                </TFullRow>
              </TBody>
            </Table>

            <Table>
              <THead>
                <TR>
                  <TH>Date</TH>
                  <TH>Category</TH>
                  <TH numeric>Amount</TH>
                </TR>
              </THead>
              <TBody>
                <TFullRow colSpan={3}>
                  <EmptyState
                    variant="error"
                    icon={<AlertIcon />}
                    title="Could not load expenses"
                    description="The server did not respond. Your filters are unchanged."
                    action={<Button variant="secondary">Try again</Button>}
                  />
                </TFullRow>
              </TBody>
            </Table>
          </div>
        </Section>

        <Section title="Skeleton" caption="Shaped like the thing it replaces.">
          <div className="flex max-w-panel flex-col gap-3 rounded-lg border bg-surface p-4">
            <Skeleton width="w-16" height="h-2" />
            <Skeleton height="h-8" />
            <div className="flex gap-3">
              <Skeleton width="w-16" />
              <Skeleton width="w-16" />
            </div>
          </div>
        </Section>

        <Section
          title="SlideOver"
          caption="Escape closes; focus moves in and back out."
        >
          <Button variant="primary" onClick={() => setSlideOverOpen(true)}>
            Open slide-over
          </Button>
        </Section>

        <div className="h-16" />
      </div>

      <SlideOver
        open={slideOverOpen}
        onClose={() => setSlideOverOpen(false)}
        title="Add expense"
        description="Amounts are entered in rupees and stored as integer cents."
        footer={
          <>
            <Button onClick={() => setSlideOverOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              loading={saving}
              onClick={() => {
                setSaving(true);
                window.setTimeout(() => {
                  setSaving(false);
                  setSlideOverOpen(false);
                }, 1200);
              }}
            >
              Save expense
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Input label="Description" placeholder="Lunch at Barista" required />
          <Input
            label="Amount"
            prefix="Rs"
            inputMode="decimal"
            placeholder="0.00"
            required
          />
          <Select
            label="Category"
            placeholder="Choose a category"
            defaultValue=""
            required
          >
            <option value="groceries">Groceries</option>
            <option value="transport">Transport</option>
            <option value="utilities">Utilities</option>
          </Select>
          <Input label="Date" type="date" defaultValue="2026-08-28" required />
          <Input label="Notes" placeholder="Optional" />
        </div>
      </SlideOver>
    </div>
  );
}

function Section({
  title,
  caption,
  children,
}: {
  title: string;
  caption?: string;
  children: ReactNode;
}) {
  return (
    // 32px above the heading, 16px below it (gap-4). The rhythm has to be
    // asymmetric: when the space within a group equals the space between
    // groups, the eye gets no grouping cue and the page reads as one list.
    <section className="flex flex-col gap-4 pt-8">
      <div className="flex flex-col gap-1 border-b pb-2">
        <h2 className="text-lg font-semibold text-text">{title}</h2>
        {caption ? <p className="text-xs text-muted">{caption}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="w-16 shrink-0 text-xs text-muted">{label}</span>
      {children}
    </div>
  );
}

function Swatch({ name, className }: { name: string; className: string }) {
  return (
    <div className="flex flex-col gap-1">
      <div className={`size-8 rounded-md border ${className}`} />
      <span className="text-xs text-muted">{name}</span>
    </div>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="size-4">
      <path
        d="M8 3.5v9M3.5 8h9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="size-4">
      <path
        d="M8 4.5v4M8 11.5h.01"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle
        cx="8"
        cy="8"
        r="6.25"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  );
}
