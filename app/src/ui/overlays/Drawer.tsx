import { type CSSProperties, type ReactNode } from 'react';
import { Dialog as BaseDialog } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import { cn } from '../lib/cn';
import { Button } from '../primitives/Button';
import { useResizeHandle } from '../layout/useResizeHandle';
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

export type DrawerWidth = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

/**
 * `xs` is 320px, and it is a real size rather than a smaller `sm`.
 *
 * It is the width of a pane — the inbox's visitor panel, the column picker, a
 * filter list — and those panes exist at that width in the page already. A
 * drawer holding one at `sm` (448) either stretches the pane's own layout or
 * leaves 128px of empty gutter beside it, which is why two surfaces put a
 * fixed-width `div` inside a drawer and let the drawer's padding double up.
 */
const WIDTHS: Record<DrawerWidth, string> = {
  xs: 'sm:max-w-80',
  sm: 'sm:max-w-md',
  md: 'sm:max-w-lg',
  lg: 'sm:max-w-2xl',
  xl: 'sm:max-w-3xl',
};

/** The same widths as pixels, for a panel the reader can drag. */
const WIDTH_PX: Record<DrawerWidth, number> = { xs: 320, sm: 448, md: 512, lg: 672, xl: 768 };

/**
 * A dragged drawer's stops.
 *
 * The floor is the `md` panel: narrower than that and a property grid stacks
 * into a column of orphans. The ceiling leaves `MIN_PAGE_VISIBLE` of the page
 * showing, because a drawer that covers everything is a route change wearing a
 * scrim — the reader loses the row they opened it from, which is the whole
 * reason this is a drawer and not a page.
 */
const MIN_DRAWER = WIDTH_PX.md;
const MIN_PAGE_VISIBLE = 320;

function maxDrawer(): number {
  if (typeof window === 'undefined') return WIDTH_PX.xl;
  return Math.max(MIN_DRAWER, window.innerWidth - MIN_PAGE_VISIBLE);
}

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
  /**
   * Drops the body's 20px padding, for a child that owns its own edges — a
   * `DataTable seated`, a `SettingGroup`, a pane that already draws its own
   * gutter. Without it that child is inset 20px from a panel it was built to
   * reach, and its hairlines stop short of the drawer's border.
   */
  flush?: boolean;
  /**
   * Let the reader drag the panel's leading edge.
   *
   * For a drawer holding a record they will sit and read — a transcript, a long
   * property grid — where the right width is a property of their screen and
   * their habit, not of the content. Pair it with `storageKey`; a width that
   * resets every time it opens is worse than one that cannot move. Ignored
   * below `sm`, where the panel is already the whole viewport.
   */
  resizable?: boolean;
  /** Where the dragged width is remembered, per user. */
  storageKey?: string;
  /**
   * Drop the header's hairline, for a panel whose first child draws its own.
   *
   * A tab row directly under the header is that child: with both rules the
   * panel opens on two hairlines 40px apart, and the tab row's own underline
   * becomes the third horizontal line in 80px.
   */
  headerHairline?: boolean;
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
  flush = false,
  resizable = false,
  storageKey,
  headerHairline = true,
  dismissible = true,
  className,
}: DrawerProps) {
  const { t } = useTranslation();
  // The panel sits at the inline-end of the viewport, so its handle is on the
  // `start` edge and the hook derives the direction from that.
  const { size, dragging, paneRef, separatorProps } = useResizeHandle({
    initial: WIDTH_PX[width],
    min: MIN_DRAWER,
    max: maxDrawer,
    storageKey,
    edge: 'start',
    label: t('ds.resizeThePanel') || 'Resize the panel',
  });
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
          ref={resizable ? paneRef : undefined}
          // The dragged width is a custom property rather than an inline
          // `width`, so the `w-full` that makes this a modal on a phone still
          // wins below `sm` and only the wider breakpoint reads the number.
          style={resizable ? ({ '--drawer-width': `${size}px` } as CSSProperties) : undefined}
          className={cn(
            'motion-slide-end fixed inset-y-0 end-0 z-[var(--z-overlay)] flex w-full flex-col',
            'overflow-hidden border-s border-border bg-surface shadow-lg focus:outline-none',
            'sm:rounded-s-xl',
            resizable ? 'sm:w-[var(--drawer-width)] sm:max-w-none' : WIDTHS[width],
            className,
          )}
        >
          <OverlayHeader
            hairline={headerHairline}
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

          <div className={cn(OVERLAY_BODY, flush && 'p-0')}>{children}</div>

          {footer ? <div className={OVERLAY_FOOTER}>{footer}</div> : null}

          {/* Last in the DOM, deliberately. The handle is absolutely
              positioned, so its place here costs nothing visually — and first
              in the DOM it was the first focusable thing in the panel, which
              meant the drawer opened with a focus ring on its own edge and a
              keyboard user met "resize" before the close button and the tabs. */}
          {resizable ? (
            <div
              {...separatorProps}
              className={cn(
                // The hit area straddles the panel's leading border so the
                // border stays where the eye expects it and the target is still
                // 12px. `translate-x-1/2` is a transform and never
                // direction-aware, so RTL reverses it to keep the handle centred
                // on the (logical) `start-0` edge.
                // rtl-ok: paired with rtl:translate-x-1/2, see above.
                'absolute inset-y-0 start-0 z-10 hidden w-3 -translate-x-1/2 rtl:translate-x-1/2',
                'cursor-col-resize touch-none select-none sm:block',
                'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-500',
                dragging && 'bg-accent-50',
              )}
            />
          ) : null}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
