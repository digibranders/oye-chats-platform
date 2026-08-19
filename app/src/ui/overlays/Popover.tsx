import { type ReactNode } from 'react';
import * as RadixPopover from '@radix-ui/react-popover';
import { cn } from '../lib/cn';

export const PopoverRoot = RadixPopover.Root;
export const PopoverTrigger = RadixPopover.Trigger;
export const PopoverClose = RadixPopover.Close;
export const PopoverAnchor = RadixPopover.Anchor;

/**
 * A floating panel of arbitrary content.
 *
 * Use this — not `Menu` — whenever the panel contains a text field, a form, a
 * filter set, or anything a user types into. `role="menu"` requires every child
 * to be a menu item, so a search box inside a menu is invalid and silently
 * unreachable with a screen reader.
 *
 * Portalled, so it escapes any ancestor with `overflow: hidden`, a `transform`,
 * or a backdrop filter. The old `Select` rendered its list absolutely inside its
 * own wrapper and was clipped whenever it opened inside a scrolling dialog.
 */
export function PopoverContent({
  children,
  align = 'start',
  side = 'bottom',
  /** Width in the caller's own class, e.g. `w-72`. Defaults to fitting content. */
  className,
}: {
  children: ReactNode;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'right' | 'bottom' | 'left';
  className?: string;
}) {
  return (
    <RadixPopover.Portal>
      <RadixPopover.Content
        align={align}
        side={side}
        sideOffset={6}
        collisionPadding={8}
        className={cn(
          'z-[var(--z-overlay)] rounded-lg border border-border bg-surface shadow-md',
          'focus:outline-none motion-pop',
          // Bounded to what actually fits, so a long list scrolls in place
          // rather than running off the bottom of the window.
          'max-h-[var(--radix-popover-content-available-height)] overflow-y-auto',
          className,
        )}
      >
        {children}
      </RadixPopover.Content>
    </RadixPopover.Portal>
  );
}
