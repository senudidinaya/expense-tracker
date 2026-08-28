import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export interface EmptyStateProps {
  title: string;
  /** One line saying what to do about it, not just that there is nothing. */
  description?: string;
  icon?: ReactNode;
  /** The way out — usually a primary Button. */
  action?: ReactNode;
  /**
   * `error` keeps the same layout but states the problem in the danger colour,
   * so a failed fetch and an empty list never look alike.
   */
  variant?: "empty" | "error";
  className?: string;
}

export function EmptyState({
  title,
  description,
  icon,
  action,
  variant = "empty",
  className,
}: EmptyStateProps) {
  return (
    <div
      role={variant === "error" ? "alert" : undefined}
      className={cn(
        "flex flex-col items-center justify-center gap-3 px-6 py-12 text-center",
        className,
      )}
    >
      {icon ? (
        <span
          aria-hidden="true"
          className={cn(
            "flex size-8 items-center justify-center rounded-full",
            variant === "error"
              ? "bg-danger-subtle text-danger"
              : "bg-surface-hover text-muted",
          )}
        >
          {icon}
        </span>
      ) : null}

      <div className="flex flex-col gap-1">
        <p
          className={cn(
            "text-sm font-medium",
            variant === "error" ? "text-danger" : "text-text",
          )}
        >
          {title}
        </p>
        {description ? (
          <p className="max-w-panel text-sm text-muted">{description}</p>
        ) : null}
      </div>

      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
