import { type ReactNode } from 'react';
import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import { cn } from '../lib/cn';
import { Button } from '../primitives/Button';

export type DialogSize = 'sm' | 'md' | 'lg' | 'xl';

const SIZES: Record<DialogSize, string> = {
  sm: 'max-w-md',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
};

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Wired to `aria-describedby`, so it is read with the title on open. */
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  size?: DialogSize;
  /**
   * Allow Escape and an outside press to close.
   *
   * Set `false` only while an operation is in flight — a user who dismisses a
   * dialog mid-payment cannot tell whether the charge went through.
   */
  dismissible?: boolean;
  className?: string;
}

/**
 * A modal dialog.
 *
 * Built on Base UI so the parts that are easy to get wrong are not ours: the
 * focus trap survives portalled children (a combobox or a menu opened from
 * inside the dialog stays inside the trap), the scroll lock is shared across
 * every overlay in the app rather than counted per component, focus returns to
 * whatever opened it, and the rest of the page is inert while it is open.
 *
 * The system this replaces hand-rolled that four times, and its two scroll locks
 * kept separate counters — closing a drawer that had a dialog open restored page
 * scrolling underneath the dialog.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = 'md',
  dismissible = true,
  className,
}: DialogProps) {
  return (
    <BaseDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!dismissible && !next) return;
        onOpenChange(next);
      }}
      disablePointerDismissal={!dismissible}
    >
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="motion-overlay fixed inset-0 z-[var(--z-overlay)] bg-overlay" />
        <BaseDialog.Popup
          className={cn(
            'motion-panel fixed left-1/2 top-1/2 z-[var(--z-overlay)] flex max-h-[calc(100dvh-2rem)]',
            'w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col',
            'rounded-xl border border-border bg-surface shadow-lg focus:outline-none',
            SIZES[size],
            className,
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
            <div className="min-w-0">
              <BaseDialog.Title className="text-lg font-semibold text-text-primary">
                {title}
              </BaseDialog.Title>
              {description ? (
                <BaseDialog.Description className="mt-1 text-xs leading-relaxed text-text-secondary">
                  {description}
                </BaseDialog.Description>
              ) : null}
            </div>
            {dismissible ? (
              <BaseDialog.Close
                render={
                  <Button variant="ghost" size="icon-sm" aria-label="Close">
                    <X aria-hidden className="h-4 w-4" />
                  </Button>
                }
              />
            ) : null}
          </div>

          {/* The body scrolls, not the dialog: a footer that scrolls away takes
              the confirm button with it on a short viewport. */}
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>

          {footer ? (
            <div className="flex flex-wrap items-center justify-end gap-2 rounded-b-[inherit] border-t border-border bg-surface-sunken px-5 py-3">
              {footer}
            </div>
          ) : null}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
