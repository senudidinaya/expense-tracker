import {
  useId,
  type ReactNode,
  type Ref,
  type SelectHTMLAttributes,
} from "react";
import { cn } from "../../lib/cn";
import {
  controlBase,
  controlBorder,
  describedBy,
  Field,
  fieldIds,
} from "./Field";

export interface SelectProps extends Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  "className"
> {
  label: string;
  hint?: string;
  error?: string;
  /**
   * Rendered as a disabled first option when the select has no value — the
   * "Choose a category" prompt. Omit it for a select that always has a value.
   */
  placeholder?: string;
  children: ReactNode;
  className?: string;
  ref?: Ref<HTMLSelectElement>;
}

/**
 * A native `<select>`, styled. Not a custom listbox: the native control gets
 * keyboard behaviour, type-ahead, and the platform's touch picker for free, and
 * nothing in this app needs an option to be anything but text.
 */
export function Select({
  label,
  hint,
  error,
  placeholder,
  required,
  id,
  children,
  className,
  ref,
  ...rest
}: SelectProps) {
  const generated = useId();
  const controlId = id ?? generated;
  const ids = fieldIds(controlId);

  return (
    <Field
      htmlFor={controlId}
      label={label}
      hint={hint}
      error={error}
      required={required}
      hintId={ids.hintId}
      errorId={ids.errorId}
      className={className}
    >
      <div className="relative flex items-center">
        <select
          {...rest}
          id={controlId}
          ref={ref}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(ids, hint, error)}
          className={cn(
            controlBase,
            controlBorder(Boolean(error)),
            // Room for the chevron, and drop the platform arrow that would
            // otherwise sit next to it.
            "appearance-none pr-8",
          )}
        >
          {placeholder ? (
            <option value="" disabled>
              {placeholder}
            </option>
          ) : null}
          {children}
        </select>
        <svg
          viewBox="0 0 16 16"
          aria-hidden="true"
          className="pointer-events-none absolute right-3 size-4 text-muted"
        >
          <path
            d="m4 6.5 4 4 4-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    </Field>
  );
}
