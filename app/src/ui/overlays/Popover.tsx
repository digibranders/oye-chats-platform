import { type ReactNode } from 'react';
import { Popover as BasePopover } from '@base-ui/react/popover';
import { cn } from '../lib/cn';

export const PopoverRoot = BasePopover.Root;
export const PopoverTrigger = BasePopover.Trigger;
export const PopoverClose = BasePopover.Close;

/**
 * A floating panel of arbitrary content.
 *
 * Use this — not `Menu` — whenever the panel contains a text field, a form, a
 * filter set, or anything a user types into. `role="menu"` requires every child
 * to be a menu item, so a search box inside a menu is invalid and silently
 * unreachable with a screen reader.
 *
 * Portalled, so it escapes any ancestor with `overflow: hidden`, a `transform`,
 * or a backdrop filter. The system this replaces rendered its select list
 * absolutely inside its own wrapper, and it was clipped whenever it opened
 * inside a scrolling dialog.
 */
export function PopoverContent({
  children,
  align = 'start',
  side = 'bottom',
  /** Width belongs to the caller, e.g. `w-72`. Defaults to fitting the content. */
  className,
}: {
  children: ReactNode;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'right' | 'bottom' | 'left';
  className?: string;
}) {
  return (
    <BasePopover.Portal>
      <BasePopover.Positioner align={align} side={side} sideOffset={6} collisionPadding={8}>
        <BasePopover.Popup
          className={cn(
            'motion-pop z-[var(--z-overlay)] rounded-lg border border-border bg-surface shadow-md',
            // Bounded to what actually fits, so a long list scrolls in place
            // rather than running off the bottom of the window.
            'max-h-[var(--available-height)] overflow-y-auto focus:outline-none',
            className,
          )}
        >
          {children}
        </BasePopover.Popup>
      </BasePopover.Positioner>
    </BasePopover.Portal>
  );
}
