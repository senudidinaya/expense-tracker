import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { cn } from "../../lib/cn";

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "ghost"
  /** Red text on a red border. The default Delete: legible, not alarming. */
  | "danger"
  /**
   * Red FILL. Reserved for the confirmation step inside a modal, where the
   * action is one click from irreversible and the weight is earned. Using it
   * on a list row spends that weight on something that still has an "are you
   * sure" ahead of it, and then the real confirm has nothing louder to say.
   */
  | "danger-confirm";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "className"
> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /**
   * Shows a spinner and blocks interaction while keeping the label, so the
   * button does not resize mid-request. Implies `disabled`.
   */
  loading?: boolean;
  /** Leading icon. Hidden from assistive tech — the label carries the meaning. */
  icon?: ReactNode;
  className?: string;
  ref?: Ref<HTMLButtonElement>;
}

const base = cn(
  "inline-flex items-center justify-center gap-2 rounded-md border font-medium",
  "whitespace-nowrap transition-colors duration-100",
  // A button is as wide as its label. `inline-flex` alone does not guarantee
  // that: as a flex child the default `align-items: stretch` blows it out to
  // the container width, which is how a primary action ends up looking like a
  // banner. `w-fit` sets an explicit width so stretch has nothing to stretch,
  // and unlike `self-start` it does not disturb vertical alignment in a row.
  "w-fit",
);

const variants: Record<ButtonVariant, string> = {
  primary: cn(
    "border-transparent bg-accent text-accent-fg",
    "enabled:hover:bg-accent-hover",
  ),
  secondary: cn(
    "border-border-strong bg-surface text-text",
    "enabled:hover:bg-surface-hover",
  ),
  ghost: cn(
    "border-transparent bg-transparent text-muted",
    // surface-active, not surface-hover: a ghost sits on the page canvas,
    // where surface-hover is within a couple of values of the background and
    // the hover simply does not appear. Without a visible hover, an unbordered
    // control next to bordered ones reads as a label.
    "enabled:hover:bg-surface-active enabled:hover:text-text",
  ),
  danger: cn(
    "border-danger bg-transparent text-danger",
    "enabled:hover:bg-danger-subtle",
  ),
  "danger-confirm": cn(
    "border-transparent bg-danger-solid text-danger-fg",
    "enabled:hover:bg-danger-solid-hover",
  ),
};

// Heights are not set: padding plus line-height decides them (md → 38px,
// sm → 30px). Every number written here is on the spacing scale; the height is
// a consequence of the scale rather than a rounded-off number laid over it.
const sizes: Record<ButtonSize, string> = {
  sm: "px-3 py-1 text-sm",
  md: "px-4 py-2 text-sm",
};

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  icon,
  disabled,
  children,
  className,
  type = "button",
  ref,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      ref={ref}
      type={type}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      className={cn(
        base,
        variants[variant],
        sizes[size],
        // "You can't do this" and "I'm doing it" are different messages and
        // must not look alike. Disabled drops to half opacity and shows a
        // blocked cursor; loading keeps full colour, adds a spinner, and shows
        // a progress cursor. Both are `disabled` in the DOM — that is a
        // correctness requirement (no double submit), not a visual one — so
        // the dimming is applied only when it is genuinely a refusal.
        loading
          ? "cursor-progress"
          : "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
    >
      {loading ? (
        <Spinner />
      ) : icon ? (
        <span aria-hidden="true" className="inline-flex shrink-0">
          {icon}
        </span>
      ) : null}
      {children}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className={cn("size-4 shrink-0 animate-spin", className)}
    >
      <circle
        cx="8"
        cy="8"
        r="6.5"
        fill="none"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="2"
      />
      <path
        d="M8 1.5a6.5 6.5 0 0 1 6.5 6.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}
