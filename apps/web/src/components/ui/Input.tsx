import {
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
} from "react";
import { cn } from "../../lib/cn";
import {
  controlBase,
  controlBorder,
  describedBy,
  Field,
  fieldIds,
} from "./Field";

export interface InputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "className" | "prefix"
> {
  label: string;
  /** Guidance shown under the control. Replaced by `error` when there is one. */
  hint?: string;
  /** Validation message. Its presence is what makes the control invalid. */
  error?: string;
  /** Static adornment inside the control — "Rs" on an amount field. */
  prefix?: ReactNode;
  className?: string;
  ref?: Ref<HTMLInputElement>;
}

export function Input({
  label,
  hint,
  error,
  prefix,
  required,
  id,
  className,
  ref,
  ...rest
}: InputProps) {
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
        {prefix ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute left-3 text-sm text-muted"
          >
            {prefix}
          </span>
        ) : null}
        <input
          {...rest}
          id={controlId}
          ref={ref}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(ids, hint, error)}
          className={cn(
            controlBase,
            controlBorder(Boolean(error)),
            // 32px clears a two-character prefix; anything wider belongs in a
            // label, not inside the box.
            prefix ? "pl-8" : undefined,
          )}
        />
      </div>
    </Field>
  );
}
