import { type ReactNode } from 'react';
import { cn } from '../lib/cn';

/**
 * The padding contract every floating surface shares.
 *
 * `Dialog`, `Drawer` and `ConfirmDialog` each restated the header, the body and
 * the footer, byte for byte, and had already begun to disagree — on `shrink-0`,
 * on whether an eyebrow existed, and on whether the description was 12/19.5 or
 * 14/24. That is the exact duplication `src/ui` exists to prevent, so it lives
 * here once and `Popover` uses the same three parts, which is what makes a
 * filter popover and a dialog read as one product.
 *
 * The measurements, and why:
 *
 * - **Header 20 / 16 plus a hairline**, which is what DESIGN.md §4 already
 *   specifies for a card header.
 * - **Body 20 all round.** Every body in the system shipped `px-5 py-4` — 20
 *   horizontal, 16 vertical — so content sat closer to the top and bottom edges
 *   than to the sides, which is the specific reason panels read as cramped rows
 *   rather than as surfaces. DESIGN.md §4 says "Card padding 20"; it means all
 *   four sides.
 * - **Footer 20 / 12**, sunken, so header and footer stay optically symmetric
 *   (58px each) around a body that breathes.
 */
export const OVERLAY_HEADER = 'relative shrink-0 border-b border-border px-5 py-4';

/**
 * The body declares `@container/page`, and that is not decoration.
 *
 * `Grid`, `Columns` and `PropertyGrid columns={2}` all size themselves against
 * the nearest container named `page`. Inside a dialog there was none, so they
 * walked past the panel and measured the *page* — a 480px drawer on a 1440px
 * screen therefore rendered a two-up grid at 240px a column, and four call
 * sites gave up and wrote `sm:grid-cols-2` by hand, which asks the viewport the
 * same wrong question. Declaring it here fixes `Dialog`, `Drawer`, `Popover` and
 * `ConfirmDialog` in one place, because all four share this body.
 */
export const OVERLAY_BODY = '@container/page min-h-0 flex-1 overflow-y-auto p-5';
export const OVERLAY_FOOTER = cn(
  'flex shrink-0 flex-wrap items-center justify-end gap-2',
  'rounded-b-[inherit] border-t border-border bg-surface-sunken px-5 py-3',
);

/**
 * The close button is positioned, not laid out.
 *
 * In a flex row it top-aligned, so the moment a dialog carried an eyebrow the X
 * floated beside the eyebrow rather than beside the title — 21px off. Taking it
 * out of the row also lets the title block use the full width until it reaches
 * the button's own column, which is what `OVERLAY_TITLE_BLOCK` reserves.
 */
export const OVERLAY_CLOSE = 'absolute right-4 top-4';
export const OVERLAY_TITLE_BLOCK = 'min-w-0 pr-9';
export const OVERLAY_TITLE = 'text-lg font-semibold text-text-primary';

/**
 * One description rung for all three overlays. It was `text-xs` with
 * `leading-relaxed` in two of them and `text-prose` in the third — the same slot
 * at 12/19.5 and at 14/24. `Alert` already argues this for the same reason: the
 * most consequential prose should not be the smallest.
 */
export const OVERLAY_DESCRIPTION = 'mt-1.5 text-prose text-text-secondary';

/**
 * A short line above the title, naming the object or the situation.
 *
 * Sentence case at full size, not the mono uppercase `Eyebrow`: these are
 * sentences, and 11px uppercase mono mangles a sentence.
 */
export const OVERLAY_EYEBROW = 'mb-1 text-base text-text-secondary';

/**
 * The scrim.
 *
 * `--color-overlay` is 0.45, at which a tinted alert behind an open drawer stays
 * fully legible and competes with the panel for attention — verified in a
 * browser. The named token is painted twice rather than a second black being
 * hardcoded here: 0.45 plus 0.27 of what remains lands at about 0.60, which is
 * where a warning tint stops reading. When the token layer grows a
 * `--color-overlay-strong`, this collapses to one class.
 */
export const OVERLAY_SCRIM = cn(
  'motion-overlay fixed inset-0 z-[var(--z-overlay)] bg-overlay',
  'after:absolute after:inset-0 after:bg-overlay/60 after:content-[""]',
);

export function OverlayHeader({ children, close }: { children: ReactNode; close?: ReactNode }) {
  return (
    <div className={OVERLAY_HEADER}>
      <div className={OVERLAY_TITLE_BLOCK}>{children}</div>
      {close ? <div className={OVERLAY_CLOSE}>{close}</div> : null}
    </div>
  );
}

export function OverlayBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn(OVERLAY_BODY, className)}>{children}</div>;
}

export function OverlayFooter({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn(OVERLAY_FOOTER, className)}>{children}</div>;
}
