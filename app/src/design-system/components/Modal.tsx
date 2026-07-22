import {
  useCallback,
  useEffect,
  useId,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '../lib/cn';

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl';

export interface ModalProps {
  open: boolean;
  /** Called on backdrop click, ESC, or the close button. */
  onClose: () => void;
  /** Accessible dialog title. Rendered in the header unless `hideHeader`. */
  title: ReactNode;
  /** Optional supporting line under the title. */
  description?: ReactNode;
  /** Max-width preset. Defaults to `md`. */
  size?: ModalSize;
  /** Suppress the built-in header (caller renders its own). Title still labels the dialog. */
  hideHeader?: boolean;
  /** Disable ESC / backdrop dismissal — e.g. while a payment is in flight. */
  dismissible?: boolean;
  /** Footer content pinned below the scrollable body. */
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}

const SIZE_CLASS: Record<ModalSize, string> = {
  sm: 'max-w-md',
  md: 'max-w-lg',
  lg: 'max-w-3xl',
  xl: 'max-w-5xl',
};

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

// Body scroll-lock is ref-counted across every open Modal instance so that
// closing one dialog while another is still open does NOT prematurely restore
// scrolling (each instance restoring its own snapshot would race).
let scrollLockCount = 0;
let scrollLockPrevOverflow = '';

function acquireScrollLock(): void {
  if (scrollLockCount === 0) {
    scrollLockPrevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  scrollLockCount += 1;
}

function releaseScrollLock(): void {
  scrollLockCount = Math.max(0, scrollLockCount - 1);
  if (scrollLockCount === 0) {
    document.body.style.overflow = scrollLockPrevOverflow;
  }
}

/**
 * Modal — the design-system dialog shell (mandate shared component). Renders
 * into a portal with a scrim, an accessible `role="dialog" aria-modal` surface,
 * focus trapping, ESC-to-close, background scroll lock, and focus restoration
 * to the trigger on close. Theme-aware via `--ds-*` tokens.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  size = 'md',
  hideHeader = false,
  dismissible = true,
  footer,
  children,
  className,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const descId = `${baseId}-desc`;
  // The element focused before the modal opened, so we can restore it on close.
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const requestClose = useCallback(() => {
    if (dismissible) onClose();
  }, [dismissible, onClose]);

  // Capture the trigger, lock body scroll, and move focus into the panel.
  useEffect(() => {
    if (!open) return undefined;
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    acquireScrollLock();

    // Focus the first focusable node (or the panel itself) after paint.
    const raf = requestAnimationFrame(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const first = panel.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? panel).focus();
    });

    return () => {
      cancelAnimationFrame(raf);
      releaseScrollLock();
      restoreFocusRef.current?.focus?.();
    };
  }, [open]);

  // ESC + focus-trap Tab handling, scoped to the panel.
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      requestClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const panel = panelRef.current;
    if (!panel) return;
    const nodes = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (node) => node.offsetParent !== null || node === document.activeElement,
    );
    if (nodes.length === 0) {
      event.preventDefault();
      panel.focus();
      return;
    }
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:p-6">
      {/* Scrim */}
      <div
        className="fixed inset-0 bg-[var(--ds-overlay)] backdrop-blur-[2px]"
        aria-hidden="true"
        onClick={requestClose}
      />
      {/* Panel */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={cn(
          'relative my-auto w-full rounded-2xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] shadow-[var(--ds-shadow-lg)] focus-visible:outline-none',
          'flex max-h-[calc(100vh-2rem)] flex-col',
          SIZE_CLASS[size],
          className,
        )}
      >
        {hideHeader ? (
          // Keep an off-screen label so the dialog is still named for AT.
          <h2 id={titleId} className="sr-only">
            {title}
          </h2>
        ) : (
          <header className="flex items-start justify-between gap-4 border-b border-[var(--ds-border)] px-6 py-4">
            <div className="min-w-0">
              <h2 id={titleId} className="text-[16px] font-semibold text-[var(--ds-text)]">
                {title}
              </h2>
              {description && (
                <p id={descId} className="mt-1 text-[13px] leading-relaxed text-[var(--ds-text-muted)]">
                  {description}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={requestClose}
              aria-label="Close"
              className="-mr-1.5 -mt-0.5 shrink-0 rounded-lg p-1.5 text-[var(--ds-text-subtle)] transition-colors hover:bg-[var(--ds-bg-hover)] hover:text-[var(--ds-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)]"
            >
              <X size={18} aria-hidden="true" />
            </button>
          </header>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>

        {footer && (
          <footer className="flex items-center justify-end gap-3 border-t border-[var(--ds-border)] px-6 py-4">
            {footer}
          </footer>
        )}
      </div>
    </div>,
    document.body,
  );
}
