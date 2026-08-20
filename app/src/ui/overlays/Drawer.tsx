import { type ReactNode } from 'react';
import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import { cn } from '../lib/cn';
import { Button } from '../primitives/Button';
import {
  OVERLAY_BODY,
  OVERLAY_DESCRIPTION,
  OVERLAY_EYEBROW,
  OVERLAY_FOOTER,
  OVERLAY_SCRIM,
  OVERLAY_TITLE,
  OverlayHeader,
} from './overlayParts';

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
  /** A short line above the title, naming the record's type. */
  eyebrow?: ReactNode;
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
 * useless gutter, so it simply becomes one, and it drops its radius at the same
 * breakpoint because a full-bleed panel has no leading edge to round.
 *
 * **The leading edge is `--radius-xl`, 14px.** DESIGN.md §4 assigns modals and
 * drawers 14 and this panel shipped flush square on every corner, which is one
 * of the two things a review of the rendered pixels caught. The doc is right and
 * the code was wrong: the three edges anchored to the viewport stay square, and
 * the one edge that is actually a boundary between the panel and the page it
 * covers is rounded. Header, body and footer come from `overlayParts`, so this
 * and `Dialog` cannot drift again.
 */
export function Drawer({
  open,
  onOpenChange,
  title,
  eyebrow,
  description,
  children,
  footer,
  width = 'md',
  dismissible = true,
  className,
}: DrawerProps) {
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
        <BaseDialog.Backdrop className={OVERLAY_SCRIM} />
        <BaseDialog.Popup
          className={cn(
            'motion-slide-right fixed inset-y-0 right-0 z-[var(--z-overlay)] flex w-full flex-col',
            'overflow-hidden border-l border-border bg-surface shadow-lg focus:outline-none',
            'sm:rounded-l-xl',
            WIDTHS[width],
            className,
          )}
        >
          <OverlayHeader
            close={
              dismissible ? (
                <BaseDialog.Close
                  render={
                    <Button variant="ghost" size="icon-sm" aria-label="Close">
                      <X aria-hidden />
                    </Button>
                  }
                />
              ) : null
            }
          >
            {eyebrow ? <p className={OVERLAY_EYEBROW}>{eyebrow}</p> : null}
            <BaseDialog.Title className={OVERLAY_TITLE}>{title}</BaseDialog.Title>
            {description ? (
              <BaseDialog.Description className={OVERLAY_DESCRIPTION}>
                {description}
              </BaseDialog.Description>
            ) : null}
          </OverlayHeader>

          <div className={OVERLAY_BODY}>{children}</div>

          {footer ? <div className={OVERLAY_FOOTER}>{footer}</div> : null}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
