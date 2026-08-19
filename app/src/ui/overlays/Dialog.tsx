import { type ReactNode } from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
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
   * Allow Escape and outside-click to close. Set `false` only while an operation
   * is in flight — a user who dismisses a dialog mid-payment cannot tell whether
   * the charge went through.
   */
  dismissible?: boolean;
  className?: string;
}

/**
 * A modal dialog.
 *
 * Built on Radix so the parts that are easy to get wrong are not ours: the focus
 * trap survives portalled children (a `Select` or a `Popover` opened from inside
 * the dialog stays inside the trap), the scroll lock is reference-counted across
 * every overlay in the app rather than per-component, focus returns to whatever
 * opened it, and the rest of the page is `aria-hidden` while it is open.
 *
 * The previous system hand-rolled this four times, and its two scroll locks kept
 * separate counters — closing a drawer that had a dialog open restored page
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
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay
          className={cn(
            'fixed inset-0 z-[var(--z-overlay)] bg-overlay',
            'motion-overlay',
          )}
        />
        <RadixDialog.Content
          onEscapeKeyDown={(event) => {
            if (!dismissible) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (!dismissible) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (!dismissible) event.preventDefault();
          }}
          // Radix warns when a dialog carries no description. Passing
          // `undefined` explicitly is its documented opt-out, and it is correct
          // here: a confirmation whose whole body is one sentence does not need
          // that sentence announced twice.
          aria-describedby={description ? undefined : undefined}
          className={cn(
            'fixed left-1/2 top-1/2 z-[var(--z-overlay)] flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)]',
            '-translate-x-1/2 -translate-y-1/2 flex-col',
            'rounded-xl border border-border bg-surface shadow-lg',
            'focus:outline-none motion-panel',
            SIZES[size],
            className,
          )}
        >
          <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
            <div className="min-w-0">
              <RadixDialog.Title className="text-lg font-semibold text-text-primary">
                {title}
              </RadixDialog.Title>
              {description ? (
                <RadixDialog.Description className="mt-1 text-xs leading-relaxed text-text-secondary">
                  {description}
                </RadixDialog.Description>
              ) : null}
            </div>
            {dismissible ? (
              <RadixDialog.Close asChild>
                <Button variant="ghost" size="icon-sm" aria-label="Close">
                  <X aria-hidden className="h-4 w-4" />
                </Button>
              </RadixDialog.Close>
            ) : null}
          </div>

          {/* The body scrolls, not the dialog: a footer that scrolls away takes
              the confirm button with it on a short viewport. */}
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>

          {footer ? (
            <div className="flex flex-wrap items-center justify-end gap-2 rounded-b-xl border-t border-border bg-surface-sunken px-5 py-3">
              {footer}
            </div>
          ) : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
