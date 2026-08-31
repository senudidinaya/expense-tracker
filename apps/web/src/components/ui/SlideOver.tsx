import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "../../lib/cn";

export interface SlideOverProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Optional line under the title — "Changes apply to future occurrences only". */
  description?: string;
  /** Actions bar pinned to the bottom of the panel. */
  footer?: ReactNode;
  children: ReactNode;
}

/**
 * Right-hand panel for add/edit forms.
 *
 * A panel rather than a centred modal because the record behind it stays
 * visible: editing an expense while its row is still on screen is the whole
 * point. Portalled to `document.body` so it is never clipped by a table's
 * `overflow` container.
 *
 * Focus handling is deliberately shallow — focus moves into the panel on open
 * and back to the trigger on close, and Escape closes. There is no focus trap:
 * a real one is a component-library-sized problem, and the honest version is
 * that Tab can leave this panel. Revisit if the app ever stacks two.
 */
export function SlideOver({
  open,
  onClose,
  title,
  description,
  footer,
  children,
}: SlideOverProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusTo = useRef<HTMLElement | null>(null);

  // Callers pass `onClose` as an inline arrow, so it is a new function on every
  // parent render. Held in a ref rather than listed as a dependency: with it in
  // the dependency array the whole effect tears down and re-runs on any parent
  // render, which re-records `restoreFocusTo` as whatever is focused *inside*
  // the panel — and closing then returns focus to a node that no longer exists
  // instead of to the button that opened the panel.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;

    restoreFocusTo.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    // Prefer the first form control: this panel is nearly always a form, and
    // landing on the close button means the first Enter throws the form away.
    // Falls back to any focusable node, then to the panel itself (tabIndex -1),
    // so focus never stays behind on the page underneath.
    const panel = panelRef.current;
    const target =
      panel?.querySelector<HTMLElement>("input, select, textarea") ??
      panel?.querySelector<HTMLElement>(
        'button, [href], [tabindex]:not([tabindex="-1"])',
      ) ??
      panel;
    target?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onCloseRef.current();
      }
    };
    document.addEventListener("keydown", onKeyDown);

    // Hold the page still behind the panel.
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      restoreFocusTo.current?.focus();
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Scrim. Clicking it closes; it is not a control, so it carries no role
          and Escape is the documented keyboard path. */}
      <div
        aria-hidden="true"
        onClick={onClose}
        className="absolute inset-0 bg-scrim"
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        className={cn(
          "relative flex h-full w-full max-w-panel flex-col",
          "border-l bg-surface shadow-panel",
          "motion-safe:animate-slide-over",
        )}
      >
        <header className="flex items-start justify-between gap-4 border-b px-6 py-4">
          <div className="flex flex-col gap-1">
            <h2 id={titleId} className="text-lg font-semibold text-text">
              {title}
            </h2>
            {description ? (
              <p id={descriptionId} className="text-xs text-muted">
                {description}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close panel"
            className={cn(
              "-mr-2 rounded-md p-2 text-muted transition-colors duration-100",
              "hover:bg-surface-hover hover:text-text",
            )}
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" className="size-4">
              <path
                d="m4 4 8 8M12 4l-8 8"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-6">{children}</div>

        {footer ? (
          <footer className="flex items-center justify-end gap-2 border-t px-6 py-4">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
