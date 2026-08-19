import { type ReactNode } from 'react';
import * as RadixDialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '../lib/cn';
import { Button } from '../primitives/Button';

export type DrawerWidth = 'sm' | 'md' | 'lg' | 'xl';

const WIDTHS: Record<DrawerWidth, string> = {
  sm: 'sm:max-w-md',
  md: 'sm:max-w-lg',
  lg: 'sm:max-w-2xl',
  xl: 'sm:max-w-3xl',
};

export interface DrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  width?: DrawerWidth;
  dismissible?: boolean;
  className?: string;
}

/**
 * A right-hand overlay panel.
 *
 * A drawer rather than an inline expander for filters, column pickers and record
 * detail. Expanding a panel in place pushes the table hundreds of pixels down
 * and costs the reader the row they were looking at; a drawer covers the page
 * instead of moving it, so closing it puts them back exactly where they were.
 *
 * Full width below `sm` — a 420px panel on a 375px phone is a modal with a
 * useless 40px gutter, so it simply becomes one.
 */
export function Drawer({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  width = 'md',
  dismissible = true,
  className,
}: DrawerProps) {
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
          onInteractOutside={(event) => {
            if (!dismissible) event.preventDefault();
          }}
          className={cn(
            'fixed inset-y-0 right-0 z-[var(--z-overlay)] flex w-full flex-col border-l border-border bg-surface shadow-lg',
            'focus:outline-none',
            'motion-slide-right',
            WIDTHS[width],
            className,
          )}
        >
          <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-5 py-4">
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

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>

          {footer ? (
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border bg-surface-sunken px-5 py-3">
              {footer}
            </div>
          ) : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
