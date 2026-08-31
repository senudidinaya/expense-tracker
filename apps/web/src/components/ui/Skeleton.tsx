import { cn } from "../../lib/cn";
import { TD, TR } from "./Table";

export interface SkeletonProps {
  /** Any width utility — `w-full`, `w-16`. Defaults to filling its container. */
  width?: string;
  /** Any height utility. Defaults to one line of body text. */
  height?: string;
  className?: string;
}

/**
 * A loading placeholder.
 *
 * Skeletons are shaped like the content they stand in for — same row height,
 * same column widths — so the page does not jump when data lands. The pulse is
 * behind `motion-safe`; the reduced-motion rule in tokens.css stops it anyway,
 * and this makes the intent visible at the call site.
 */
export function Skeleton({
  width = "w-full",
  height = "h-4",
  className,
}: SkeletonProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "block rounded-sm bg-surface-hover motion-safe:animate-pulse",
        width,
        height,
        className,
      )}
    />
  );
}

/**
 * Skeleton rows sized for a Table. Rendered inside the real `<tbody>` so the
 * column widths that appear during loading are the ones the data will get.
 *
 * The whole block is announced once as busy rather than as a dozen empty cells.
 */
export function SkeletonRows({
  rows = 5,
  columns,
  numericColumns = [],
}: {
  rows?: number;
  columns: number;
  /** Indices whose placeholder is short and right-aligned, like an amount. */
  numericColumns?: number[];
}) {
  return (
    <>
      {Array.from({ length: rows }, (_, rowIndex) => (
        <TR key={rowIndex} aria-busy="true" aria-label="Loading">
          {Array.from({ length: columns }, (_, columnIndex) => {
            const numeric = numericColumns.includes(columnIndex);
            return (
              <TD key={columnIndex} numeric={numeric}>
                <Skeleton
                  width={numeric ? "w-16" : "w-full"}
                  className={numeric ? "ml-auto" : undefined}
                />
              </TD>
            );
          })}
        </TR>
      ))}
    </>
  );
}
