import { type ReactNode } from 'react';
import { cn } from '../lib/cn';

const TEMPLATES = {
  sm: '@4xl/page:grid-cols-[minmax(0,1fr)_18rem]',
  md: '@5xl/page:grid-cols-[minmax(0,1fr)_24rem]',
} as const;

const TEMPLATES_START = {
  sm: '@4xl/page:grid-cols-[18rem_minmax(0,1fr)]',
  md: '@5xl/page:grid-cols-[24rem_minmax(0,1fr)]',
} as const;

export interface ColumnsProps {
  /** The column that carries the page's work. */
  main: ReactNode;
  /** A summary, a live preview, a set of related actions. */
  aside: ReactNode;
  /** 18rem for a summary rail, 24rem for a live preview. */
  asideWidth?: 'sm' | 'md';
  /** Which side the aside sits on. Default `end`. */
  asidePosition?: 'start' | 'end';
  /**
   * The aside holds still while the main column scrolls. For a summary that has
   * to stay readable while the reader works beside it — an order total, a
   * widget preview.
   *
   * An aside taller than the viewport scrolls inside itself rather than pinning
   * its own bottom off screen — see the note on the component.
   */
  stickyAside?: boolean;
  /** Names the aside's landmark, e.g. "Order summary". */
  asideLabel?: string;
  className?: string;
}

/**
 * Main plus aside — the asymmetric split.
 *
 * Not `Grid`, which arranges peers. Here one column is the work and the other
 * comments on it: a form beside its live preview, an invoice beside its totals,
 * a journey chart beside its stages. Three features had already written this by
 * hand as `grid gap-8 lg:grid-cols-[minmax(0,1fr)_auto]`, where `auto` means the
 * aside's width is whatever its longest string happens to be — so the main
 * column's width changed when the data did.
 *
 * Both sides re-declare `@container/page`, which is the point of routing this
 * through the system at all: a `Grid cols={2}` dropped into an 18rem aside
 * renders one column, because 18rem is what it now measures against.
 *
 * DOM order follows visual order rather than being fixed with `order-*`. A
 * reordered flex or grid leaves the tab sequence in source order, so a keyboard
 * user tabs from the first visible column into the *last* one — and an aside on
 * the start edge is normally read first anyway.
 *
 * ## `main` is the longer column. That is the contract.
 *
 * A two-column grid is exactly as tall as its taller column, so when the aside
 * is the taller one the main column ends in a large empty rectangle — about
 * 530px of it on Deploy at 1440. Nothing this component can do fills that hole,
 * and it should not try: a grid that reflowed to hide it would move the reader's
 * column out from under them the moment a fixture changed by one row. The hole
 * is the layout telling the truth about the page — the aside is carrying the
 * work, and an aside that carries the work is not an aside. The fix is at the
 * call site, and it is one of three: put the longer block in `main`, drop to a
 * single `Stack`, or use `Grid` and admit the two blocks are peers.
 *
 * What *was* this component's fault is the sticky case. A sticky aside taller
 * than the viewport pins its top at `top-gutter` and parks everything below the
 * fold permanently out of reach — there is no scroll position that reveals it,
 * because the element has stopped moving. It now caps itself at the viewport
 * and scrolls its own overflow, so the cap costs nothing when the aside fits
 * (no scrollbar appears) and rescues it when it does not.
 */
export function Columns({
  main,
  aside,
  asideWidth = 'sm',
  asidePosition = 'end',
  stickyAside = false,
  asideLabel,
  className,
}: ColumnsProps) {
  const asideNode = (
    <aside
      aria-label={asideLabel}
      className={cn(
        '@container/page min-w-0',
        stickyAside &&
          cn(
            '@4xl/page:sticky @4xl/page:top-gutter @4xl/page:self-start',
            '@4xl/page:max-h-[calc(100dvh-var(--spacing-gutter)*2)] @4xl/page:overflow-y-auto',
          ),
      )}
    >
      {aside}
    </aside>
  );

  return (
    <div
      className={cn(
        'grid gap-6',
        asidePosition === 'start' ? TEMPLATES_START[asideWidth] : TEMPLATES[asideWidth],
        className,
      )}
    >
      {asidePosition === 'start' ? asideNode : null}
      <div className="@container/page min-w-0">{main}</div>
      {asidePosition === 'end' ? asideNode : null}
    </div>
  );
}
