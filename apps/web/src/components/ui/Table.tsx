import type {
  HTMLAttributes,
  ReactNode,
  TdHTMLAttributes,
  ThHTMLAttributes,
} from "react";
import { cn } from "../../lib/cn";

/**
 * A dense data table, built from the real table elements so screen readers and
 * Ctrl+F both work.
 *
 * The `numeric` prop on TH/TD is the whole reason this is a component and not a
 * pile of classes: it right-aligns *and* switches on tabular figures, so a
 * column of amounts can never be set in proportional numerals by accident.
 */

export function Table({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLTableElement>) {
  return (
    // The wrapper owns the frame and the horizontal scroll; the table itself
    // stays a plain table.
    <div className="overflow-x-auto rounded-lg border bg-surface">
      <table
        {...rest}
        className={cn("w-full border-collapse text-sm", className)}
      >
        {children}
      </table>
    </div>
  );
}

export function THead({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead {...rest} className={cn("border-b", className)}>
      {children}
    </thead>
  );
}

export function TBody({
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <tbody {...rest} className={cn("divide-y divide-border", className)}>
      {children}
    </tbody>
  );
}

export interface TRProps extends HTMLAttributes<HTMLTableRowElement> {
  /** Row responds to the pointer. Set it when the row itself is clickable. */
  interactive?: boolean;
  selected?: boolean;
}

export function TR({
  interactive = false,
  selected = false,
  className,
  children,
  ...rest
}: TRProps) {
  return (
    <tr
      {...rest}
      aria-selected={selected || undefined}
      className={cn(
        "transition-colors duration-100",
        selected && "bg-accent-subtle",
        interactive && "cursor-pointer hover:bg-surface-hover",
        className,
      )}
    >
      {children}
    </tr>
  );
}

export interface CellProps {
  /** Right-aligned and set in tabular figures. Use for every money column. */
  numeric?: boolean;
}

export function TH({
  numeric = false,
  className,
  children,
  ...rest
}: ThHTMLAttributes<HTMLTableCellElement> & CellProps) {
  return (
    <th
      {...rest}
      scope={rest.scope ?? "col"}
      className={cn(
        "px-4 py-2 text-xs font-medium tracking-wide text-muted",
        numeric ? "tabular text-right" : "text-left",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function TD({
  numeric = false,
  className,
  children,
  ...rest
}: TdHTMLAttributes<HTMLTableCellElement> & CellProps) {
  return (
    <td
      {...rest}
      className={cn(
        "px-4 py-3 align-middle text-text",
        numeric ? "tabular text-right" : "text-left",
        className,
      )}
    >
      {children}
    </td>
  );
}

/**
 * A full-width row for "no results", a totals line, or an error — anything that
 * spans the table instead of filling its columns.
 */
export function TFullRow({
  colSpan,
  className,
  children,
}: {
  colSpan: number;
  className?: string;
  children: ReactNode;
}) {
  return (
    <tr>
      <td colSpan={colSpan} className={cn("px-4 py-6", className)}>
        {children}
      </td>
    </tr>
  );
}
