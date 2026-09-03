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
import { useTranslation } from '../../i18n/useTranslation';

export type DialogSize = 'sm' | 'md' | 'lg' | 'xl' | 'full';

/**
 * The widths a dialog may have.
 *
 * `xl` is `max-w-reading` — the system's own named width for a reading column —
 * rather than Tailwind's `max-w-4xl`, which is the same 896px under a name that
 * belongs to a scale this design system otherwise does not use.
 * `full` expands to fill the viewport (used for diagram expands, etc.).
 */
const SIZES: Record<DialogSize, string> = {
  sm: 'max-w-md',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-reading',
  full: 'max-w-[calc(100vw-2rem)]',
};

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /**
   * A short line above the title, naming the object or the situation — "You
   * already have one chatbot on Free".
   *
   * Sentence case and full size, not the mono uppercase `Eyebrow`: these are
   * sentences, and 11px uppercase mono mangles a sentence. It sits outside the
   * accessible name, so the dialog is still announced by its title.
   */
  eyebrow?: ReactNode;
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
 *
 * The panel clips its own children. A footerless dialog whose body scrolled
 * painted the last row of content square across the panel's two bottom corners —
 * a 14px crescent of content sitting outside the panel's own shape, and the
 * clearest instance of the owner's "corners are broken". `overflow-hidden` is
 * safe here because everything that has to escape the panel — `Select`, `Menu`,
 * `Combobox`, `Tooltip` — portals out of it.
 *
 * `100dvw` rather than `100vw`: `vw` includes the scrollbar, so on Windows the
 * panel was a scrollbar's width wider than the space it had.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  eyebrow,
  description,
  children,
  footer,
  size = 'md',
  dismissible = true,
  className,
}: DialogProps) {
  const { t } = useTranslation();
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
            // rtl-ok: centers the panel on the viewport — the midpoint is the
            // same regardless of reading direction.
            'motion-panel fixed left-1/2 top-1/2 z-[var(--z-overlay)] flex max-h-[calc(100dvh-2rem)]',
            'w-[calc(100dvw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col', // rtl-ok: centering, see above
            'overflow-hidden rounded-xl border border-border bg-surface shadow-lg focus:outline-none',
            SIZES[size],
            className,
          )}
        >
          <OverlayHeader
            close={
              dismissible ? (
                <BaseDialog.Close
                  render={
                    <Button variant="ghost" size="icon-sm" aria-label={t('ds.close') || 'Close'}>
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

          {/* The body scrolls, not the dialog: a footer that scrolls away takes
              the confirm button with it on a short viewport. */}
          <div className={OVERLAY_BODY}>{children}</div>

          {footer ? <div className={OVERLAY_FOOTER}>{footer}</div> : null}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
