import type { ReactNode } from "react";

/**
 * The frame both auth screens sit in: centred card, title, an error banner
 * slot, and a footer for the link across to the other screen.
 *
 * It exists so `LoginPage` and `SignupPage` cannot drift apart visually, and
 * so Task 19 only has to drop a form into `children`.
 */
export function AuthCard({
  title,
  subtitle,
  error,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  /** The envelope's `message`, shown verbatim — it is written for users. */
  error?: string | null;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg px-6 py-12">
      <div className="flex w-full max-w-panel flex-col gap-6 rounded-lg border border-border bg-surface p-8 shadow-panel">
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold text-text">{title}</h1>
          {subtitle ? <p className="text-sm text-muted">{subtitle}</p> : null}
        </div>

        {error ? (
          <p
            role="alert"
            className="rounded-md border border-danger bg-danger-subtle px-3 py-2 text-sm text-danger"
          >
            {error}
          </p>
        ) : null}

        {children}

        {footer ? <p className="text-sm text-muted">{footer}</p> : null}
      </div>
    </div>
  );
}
