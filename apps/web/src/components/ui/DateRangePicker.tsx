import { useId } from "react";
import { cn } from "../../lib/cn";
import { controlBase, controlBorder } from "./Field";

/** Dates cross every boundary in this app as `YYYY-MM-DD`. `null` = unbounded. */
export interface DateRange {
  from: string | null;
  to: string | null;
}

export interface DateRangePickerProps {
  value: DateRange;
  onChange: (next: DateRange) => void;
  /** Names the group for screen readers; not shown unless `showLegend`. */
  legend?: string;
  showLegend?: boolean;
  disabled?: boolean;
  /**
   * "Today" for preset maths. Injectable so presets are deterministic in tests
   * and in the kitchen sink; production leaves it out.
   */
  today?: Date;
  className?: string;
}

/**
 * Formats a Date as `YYYY-MM-DD` from its *local* parts.
 *
 * Not `toISOString().slice(0, 10)`: that converts to UTC first, so anywhere
 * east of Greenwich — Sri Lanka included — "today" becomes yesterday for the
 * first 5.5 hours of every day. Dates in this app are calendar dates
 * (Postgres DATE), never instants.
 */
export function toISODate(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

interface Preset {
  label: string;
  range: (today: Date) => DateRange;
}

const PRESETS: Preset[] = [
  {
    label: "This month",
    range: (t) => ({
      from: toISODate(new Date(t.getFullYear(), t.getMonth(), 1)),
      to: toISODate(t),
    }),
  },
  {
    label: "Last 30 days",
    range: (t) => ({
      from: toISODate(
        new Date(t.getFullYear(), t.getMonth(), t.getDate() - 29),
      ),
      to: toISODate(t),
    }),
  },
  {
    label: "Last month",
    range: (t) => ({
      from: toISODate(new Date(t.getFullYear(), t.getMonth() - 1, 1)),
      // Day 0 of this month is the last day of the previous one.
      to: toISODate(new Date(t.getFullYear(), t.getMonth(), 0)),
    }),
  },
  {
    label: "This year",
    range: (t) => ({
      from: toISODate(new Date(t.getFullYear(), 0, 1)),
      to: toISODate(t),
    }),
  },
];

/**
 * Two native date inputs plus the four ranges people actually pick.
 *
 * Not a custom calendar popover: `input[type=date]` brings keyboard entry,
 * locale-aware display, and the platform's own picker — including the mobile
 * wheel — for none of the code a hand-rolled calendar costs. The presets are
 * what make it fast; the calendar was never the slow part.
 */
export function DateRangePicker({
  value,
  onChange,
  legend = "Date range",
  showLegend = false,
  disabled = false,
  today,
  className,
}: DateRangePickerProps) {
  const id = useId();
  const fromId = `${id}-from`;
  const toId = `${id}-to`;
  const errorId = `${id}-error`;

  // The one thing a two-input range can get wrong. Caught here rather than at
  // the server round-trip, because an inverted range is not a server concern.
  const inverted =
    value.from !== null && value.to !== null && value.from > value.to;

  const activePreset = PRESETS.find((preset) => {
    const range = preset.range(today ?? new Date());
    return range.from === value.from && range.to === value.to;
  });

  const inputClass = cn(controlBase, controlBorder(inverted), "w-auto");

  return (
    <fieldset
      disabled={disabled}
      className={cn("flex flex-wrap items-end gap-3 border-0 p-0", className)}
    >
      <legend
        className={cn(
          "text-xs font-medium text-muted",
          !showLegend && "sr-only",
        )}
      >
        {legend}
      </legend>

      <div className="flex flex-col gap-1">
        <label htmlFor={fromId} className="text-xs font-medium text-muted">
          From
        </label>
        <input
          id={fromId}
          type="date"
          value={value.from ?? ""}
          max={value.to ?? undefined}
          aria-invalid={inverted || undefined}
          aria-describedby={inverted ? errorId : undefined}
          onChange={(event) =>
            onChange({ ...value, from: event.target.value || null })
          }
          className={inputClass}
        />
      </div>

      <div className="flex flex-col gap-1">
        <label htmlFor={toId} className="text-xs font-medium text-muted">
          To
        </label>
        <input
          id={toId}
          type="date"
          value={value.to ?? ""}
          min={value.from ?? undefined}
          aria-invalid={inverted || undefined}
          aria-describedby={inverted ? errorId : undefined}
          onChange={(event) =>
            onChange({ ...value, to: event.target.value || null })
          }
          className={inputClass}
        />
      </div>

      <div className="flex flex-wrap items-center gap-1">
        {PRESETS.map((preset) => {
          const active = preset === activePreset;
          return (
            <button
              key={preset.label}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(preset.range(today ?? new Date()))}
              className={cn(
                "rounded-md border px-3 py-1 text-xs font-medium",
                "transition-colors duration-100",
                active
                  ? "border-accent bg-accent-subtle text-accent"
                  : "border-border-strong bg-surface text-muted enabled:hover:bg-surface-hover enabled:hover:text-text",
                "disabled:cursor-not-allowed disabled:opacity-50",
              )}
            >
              {preset.label}
            </button>
          );
        })}

        {value.from !== null || value.to !== null ? (
          <button
            type="button"
            onClick={() => onChange({ from: null, to: null })}
            className={cn(
              "rounded-md px-3 py-1 text-xs font-medium text-muted",
              "transition-colors duration-100",
              // surface-active for the same reason as the ghost Button: this
              // control has no border, and on the page canvas surface-hover is
              // too close to the background to register as a hover.
              "enabled:hover:bg-surface-active enabled:hover:text-text",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            Clear
          </button>
        ) : null}
      </div>

      {inverted ? (
        <p id={errorId} role="alert" className="w-full text-xs text-danger">
          The start date is after the end date.
        </p>
      ) : null}
    </fieldset>
  );
}
