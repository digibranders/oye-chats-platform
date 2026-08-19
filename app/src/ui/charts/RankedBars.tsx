import { type ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface RankedBar {
  /** Stable identity, so a re-sort does not re-key every row. */
  id: string;
  label: ReactNode;
  /** The magnitude the bar is drawn from. */
  value: number;
  /** What is printed at the end of the row. Defaults to the value, formatted. */
  display?: ReactNode;
  /** A second line under the label — a share, a date, a source. */
  meta?: ReactNode;
  /** Selects this row from the chart. Makes the whole row a real control. */
  onSelect?: () => void;
  /** Marks the row as the current selection. */
  selected?: boolean;
}

export interface RankedBarsProps {
  items: readonly RankedBar[];
  /**
   * The denominator. Defaults to the largest value, which makes the chart
   * proportional *within itself*; pass a total to make it proportional to
   * something outside it (a plan limit, all conversations).
   */
  max?: number;
  /** Names the chart for assistive tech. Required. */
  label: string;
  /** Tone of the fill. Neutral ink unless the ranking itself means something. */
  tone?: 'ink' | 'accent' | 'success' | 'warning' | 'danger';
  className?: string;
}

const TONE_FILL: Record<NonNullable<RankedBarsProps['tone']>, string> = {
  ink: 'bg-ink',
  accent: 'bg-accent-500',
  success: 'bg-success-fill',
  warning: 'bg-warning-fill',
  danger: 'bg-danger-fill',
};

/**
 * A ranked list, drawn as bars.
 *
 * Top questions, a funnel's stages, a ratings distribution, the pages that send
 * the most visitors — the same shape every time: a label, a proportional bar,
 * and a figure. Three surfaces were drawing it by hand at three different
 * heights, which is exactly the duplication this directory exists to prevent.
 *
 * It is not `Progress` and not `Meter`. Those two answer "how far through is
 * this?" and "how much of my allowance is gone?"; both are about one quantity
 * against a known ceiling, and both carry `progressbar`/`meter` semantics that
 * are wrong for a comparison between peers. This is a chart, so it is a list
 * with the numbers in it — which is also what makes it readable with the bars
 * turned off, on a screen reader, and in print.
 *
 * The bar itself is `aria-hidden`: the row already states its label and its
 * value in text, and announcing the geometry a second time adds nothing.
 */
export function RankedBars({ items, max, label, tone = 'ink', className }: RankedBarsProps) {
  const ceiling = max ?? items.reduce((highest, item) => Math.max(highest, item.value), 0);

  return (
    <ol aria-label={label} className={cn('flex flex-col', className)}>
      {items.map((item) => {
        // A zero ceiling means every value is zero. Draw nothing rather than
        // dividing by it and painting every row full.
        const share = ceiling > 0 ? Math.min(100, (Math.max(0, item.value) / ceiling) * 100) : 0;
        const body = (
          <>
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 flex-1 truncate text-base text-text-primary">{item.label}</span>
              <span className="figure shrink-0 text-sm font-medium text-text-primary">
                {item.display ?? item.value}
              </span>
            </div>
            <div
              aria-hidden
              className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken"
            >
              <div
                className={cn('h-full rounded-full transition-[width] duration-[var(--dur-slow)]', TONE_FILL[tone])}
                style={{ width: `${share}%` }}
              />
            </div>
            {item.meta ? <p className="mt-1 text-2xs text-text-tertiary">{item.meta}</p> : null}
          </>
        );

        return (
          <li key={item.id} className="border-b border-border last:border-b-0">
            {item.onSelect ? (
              <button
                type="button"
                aria-pressed={item.selected}
                onClick={item.onSelect}
                className={cn(
                  'block w-full px-4 py-3 text-left transition-colors duration-[var(--dur-fast)]',
                  item.selected ? 'bg-accent-50' : 'hover:bg-surface-hover',
                )}
              >
                {body}
              </button>
            ) : (
              <div className="px-4 py-3">{body}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
