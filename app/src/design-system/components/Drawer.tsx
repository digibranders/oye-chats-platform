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

export type DrawerWidth = 'sm' | 'md';

export interface DrawerProps {
  open: boolean;
  /** Called on backdrop click, ESC, or the close button. */
  onClose: () => void;
  /** Accessible dialog title, rendered in the sticky header. */
  title: ReactNode;
  /** Optional supporting line under the title. */
  description?: ReactNode;
  /** Panel width preset. Defaults to `sm`. */
  width?: DrawerWidth;
  /** Disable ESC / backdrop dismissal - e.g. while a payment is in flight. */
  dismissible?: boolean;
  /** Footer content pinned below the scrollable body. */
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
}

const WIDTH_CLASS: Record<DrawerWidth, string> = {
  sm: 'max-w-md',
  md: 'max-w-lg',
};

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

// Body scroll-lock is ref-counted across every open overlay instance so that
// closing one while another is still open does NOT prematurely restore
// scrolling. Mirrors the Modal implementation so the two share one lock stack.
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
 * Drawer - a right-anchored, full-height sheet (mandate shared component).
 * Same a11y contract as {@link Modal} (portal, scrim, `role="dialog"
 * aria-modal`, focus trap, ESC-to-close, scroll lock, focus restoration) but
 * slides in from the trailing edge - the right surface for focused confirm /
 * detail flows that shouldn't blank the whole page. Theme-aware via `--ds-*`.
 */
export function Drawer({
  open,
  onClose,
  title,
  description,
  width = 'sm',
  dismissible = true,
  footer,
  children,
  className,
}: DrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const descId = `${baseId}-desc`;
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const requestClose = useCallback(() => {
    if (dismissible) onClose();
  }, [dismissible, onClose]);

  useEffect(() => {
    if (!open) return undefined;
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    acquireScrollLock();

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
    <div className="fixed inset-0 z-50 flex justify-end">
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
          'relative flex h-full w-full flex-col border-l border-[var(--ds-border)] bg-[var(--ds-bg-surface)] shadow-[var(--ds-shadow-lg)] focus-visible:outline-none',
          WIDTH_CLASS[width],
          className,
        )}
      >
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
            className="-mr-1.5 -mt-0.5 shrink-0 rounded-[var(--ds-radius-md)] p-1.5 text-[var(--ds-text-subtle)] transition-colors hover:bg-[var(--ds-bg-hover)] hover:text-[var(--ds-text)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>

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
