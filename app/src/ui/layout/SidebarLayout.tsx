import { type ReactNode } from 'react';
import { cn } from '../lib/cn';

const NAV_WIDTHS = {
  sm: '@4xl/page:grid-cols-[12rem_minmax(0,1fr)]',
  md: '@4xl/page:grid-cols-[14rem_minmax(0,1fr)]',
} as const;

export interface SidebarLayoutProps {
  /**
   * The destinations, as individual links — not a wrapped list.
   *
   * The layout owns the `nav`, the list and the direction, because the
   * direction changes: below the breakpoint these are a horizontal scroller and
   * above it a vertical column, and a caller that pre-wrapped them in a
   * `flex-col` would have made that flip impossible.
   */
  nav: ReactNode;
  /** Names the nav landmark, e.g. "Workspace settings". */
  navLabel: string;
  children: ReactNode;
  /** 12rem for one-word labels, 14rem for two. Default `md`. */
  navWidth?: 'sm' | 'md';
  className?: string;
}

/**
 * Secondary navigation beside its content.
 *
 * The shape every settings surface in the console wants, and which two of them
 * had already written by hand — one as `lg:flex lg:gap-8` with a `lg:w-56`
 * sidebar, the other as three separate `Page width="default"` routes, which is
 * how the settings pages ended up 148px to the right of every other page.
 *
 * The nav is sticky above the breakpoint, because the whole reason for a
 * secondary nav is to move between long sections without scrolling back. Below
 * it, the same links become a horizontal scroller: a vertical list of eight
 * destinations above the content on a phone is a screen of nav before any
 * content.
 *
 * Both columns re-declare `@container/page`, so a `Grid` in the content column
 * measures the content column and not the page.
 */
export function SidebarLayout({
  nav,
  navLabel,
  children,
  navWidth = 'md',
  className,
}: SidebarLayoutProps) {
  return (
    <div className={cn('grid gap-6 @4xl/page:gap-8', NAV_WIDTHS[navWidth], className)}>
      <nav
        aria-label={navLabel}
        className={cn(
          'min-w-0',
          '@4xl/page:sticky @4xl/page:top-gutter @4xl/page:self-start',
          // A row that scrolls, then a column that does not. `[&>*]:shrink-0`
          // keeps the links at their natural width in the scroller instead of
          // squeezing eight of them into the viewport.
          'flex gap-1 overflow-x-auto [&>*]:shrink-0',
          '@4xl/page:flex-col @4xl/page:gap-0.5 @4xl/page:overflow-x-visible',
        )}
      >
        {nav}
      </nav>
      <div className="@container/page min-w-0">{children}</div>
    </div>
  );
}
