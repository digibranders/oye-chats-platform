import { type ReactNode } from 'react';
import { cn } from '../lib/cn';

/**
 * The ramp. Fixed, and deliberately not overridable.
 *
 * Every step is a **container** query against `/page` — the measure of the box
 * the grid is actually in, which `Page` declares and which `Column`, `Columns`,
 * `SidebarLayout`, `SplitPane` and `PropertyGrid` re-declare whenever they
 * narrow it. A viewport query would put two columns inside a 320px inbox pane
 * on a 1920px screen, which is exactly what `sm:grid-cols-2` was already doing
 * in the visitor panel.
 *
 * `4` starts at two columns rather than one: a four-up grid is a row of small
 * widgets, and small widgets stacked one per row is the failure mode this
 * component exists to end.
 */
const COLS = {
  2: 'grid-cols-1 @3xl/page:grid-cols-2',
  3: 'grid-cols-1 @2xl/page:grid-cols-2 @5xl/page:grid-cols-3',
  4: 'grid-cols-2 @3xl/page:grid-cols-4',
} as const;

export interface GridProps {
  children: ReactNode;
  /** Columns at the widest step. The ramp is fixed; there is no 5-up. */
  cols: 2 | 3 | 4;
  /** 16 between cards (the default), 24 between card *groups*. */
  gap?: 'card' | 'section';
  /**
   * Equal-height children, so a row of cards shares one bottom edge. `start`
   * lets each card be its own height — right for a row of disclosures, wrong
   * for a row of panels.
   */
  align?: 'stretch' | 'start';
  /** `ul` when the children are a list of the same kind of thing. */
  as?: 'div' | 'ul';
  /** Names the list. Only meaningful with `as="ul"`. */
  label?: string;
  className?: string;
}

/**
 * A row of peers.
 *
 * This is the primitive the system was missing. For a while `Stack`
 * (`flex-col gap-6`) was the only multi-child layout `src/ui` exported, so
 * `features/` grew 88 hand-written `grid-cols-*` strings across at least
 * fourteen different breakpoint contracts — and every page whose author did not
 * hand-roll one rendered a single column of full-width cards. `CLAUDE.md`
 * non-negotiable #1 says a feature may not define a visual primitive; layout is
 * a visual primitive, and nobody noticed because layout does not look like a
 * component.
 *
 * So: two or more cards that answer the same question at the same altitude go in
 * a `Grid`, and a feature does not write `grid-cols-`. Stripe's Home is a 2-up
 * grid of panels above 1024 and 3-up above 1440; Linear's settings are a 2-up
 * grid of groups. Neither stacks peer panels in one column on a wide screen.
 *
 * The grid does not decide what a card looks like — but a card in a grid is a
 * widget, so it takes `CardHeader size="sm"`.
 */
export function Grid({
  children,
  cols,
  gap = 'card',
  align = 'stretch',
  as: Tag = 'div',
  label,
  className,
}: GridProps) {
  return (
    <Tag
      aria-label={Tag === 'ul' ? label : undefined}
      className={cn(
        'grid',
        COLS[cols],
        gap === 'section' ? 'gap-6' : 'gap-4',
        align === 'start' && 'items-start',
        className,
      )}
    >
      {children}
    </Tag>
  );
}
