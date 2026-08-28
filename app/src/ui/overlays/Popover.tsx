import { type ReactNode } from 'react';
import { Popover as BasePopover } from '@base-ui/react/popover';
import { cn } from '../lib/cn';
import { PANEL_BASE, PANEL_POSITIONER } from './panelStyles';
import { OVERLAY_BODY, OVERLAY_FOOTER, OVERLAY_HEADER, OVERLAY_TITLE } from './overlayParts';

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
 *
 * **The panel does not scroll itself; `PopoverBody` does.** It was
 * `overflow-y-auto` on the root, so a filter popover with a title and an Apply
 * button lost both as soon as the list got long — the exact defect `Dialog`
 * documents guarding against, in the overlay next door. The three parts share
 * `Dialog`'s padding contract, so a filter popover and a dialog are one
 * vocabulary rather than two.
 *
 * Width belongs to the caller, e.g. `w-72`. The minimum does not: three
 * floating panels shipped three different ones (176 / 224 / none), none derived
 * from anything.
 */
export function PopoverContent({
  children,
  align = 'start',
  side = 'bottom',
  className,
}: {
  children: ReactNode;
  align?: 'start' | 'center' | 'end';
  side?: 'top' | 'right' | 'bottom' | 'left';
  className?: string;
}) {
  return (
    <BasePopover.Portal>
      {/* The z-index belongs on the Positioner. Base UI positions that element
          and renders the Popup as a static child, where `z-index` does nothing —
          so the documented ladder governed no anchored overlay in the app. */}
      <BasePopover.Positioner
        className={PANEL_POSITIONER}
        align={align}
        side={side}
        sideOffset={6}
        collisionPadding={8}
      >
        <BasePopover.Popup
          className={cn(
            PANEL_BASE,
            'flex max-h-[var(--available-height)] min-w-52 flex-col overflow-hidden',
            className,
          )}
        >
          {children}
        </BasePopover.Popup>
      </BasePopover.Positioner>
    </BasePopover.Portal>
  );
}

export function PopoverHeader({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn(OVERLAY_HEADER, className)}>
      <p className={OVERLAY_TITLE}>{children}</p>
    </div>
  );
}

/**
 * The scrolling region, at the same 20px as every other overlay body.
 *
 * The padding is not only rhythm here: an outline **is** clipped by an
 * `overflow` ancestor — it follows `border-radius` and takes no space, but it is
 * painted inside the ancestor's clip rect like any other ink — so a
 * `SearchField` or a `Button` sitting flush against the edge of a scrolling
 * panel loses its ring on the clipped side. 20px of inset is 5× the 4px a ring
 * needs. DESIGN.md §5 currently claims an outline "is never clipped by an
 * `overflow: hidden` ancestor"; that half of the sentence is false, and it was
 * licensing scroll containers that clip focus rings.
 */
export function PopoverBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn(OVERLAY_BODY, className)}>{children}</div>;
}

export function PopoverFooter({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn(OVERLAY_FOOTER, className)}>{children}</div>;
}
