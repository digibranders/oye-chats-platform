import { type ReactNode } from 'react';
import { cn } from '../lib/cn';
import { EmptyState, LoadingBars } from '../data/States';
import { useTranslation } from '../../i18n/useTranslation';

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
  /**
   * The fill.
   *
   * `data` is the categorical ramp's first series, which is what DESIGN.md §2.5
   * reserves for data. It is the default because the alternative on offer at the
   * three panels that hand-drew this was `--color-accent-500` — the interactive
   * blue, which §1.1 spends on links, focus and selection and nothing else — or
   * `--color-accent-50`, a *background* token, which measured 1.05:1 against the
   * track it was painted on and could not be seen at all.
   *
   * `--color-chart-1` itself used to be #2F5FE0, one step off `accent-500`, so
   * the default fill still read as interactive — the rule was stated in §2.5 and
   * broken by the token it pointed at. It is now a deep petrol navy at 10.0 on
   * the canvas, against the accent's 4.09: unmistakably not a link, and still the
   * strongest first series a warm-paper ramp can carry.
   *
   * `ink` stays for the surfaces that already ask for it; a status tone is for
   * when the ranking itself carries one.
   */
  tone?: 'data' | 'ink' | 'success' | 'warning' | 'danger';
  loading?: boolean;
  /** Rows to draw while loading. Match what the surface usually returns. */
  loadingRows?: number;
  emptyTitle?: string;
  emptyDescription?: string;
  className?: string;
}

const TONE_FILL: Record<NonNullable<RankedBarsProps['tone']>, string> = {
  data: 'bg-chart-1',
  ink: 'bg-ink',
  success: 'bg-success-fill',
  warning: 'bg-warning-fill',
  danger: 'bg-danger-fill',
};

/**
 * A ranked list, drawn as bars.
 *
 * Top questions, a funnel's stages, a ratings distribution, the pages that send
 * the most visitors — the same shape every time: a label, a proportional bar,
 * and a figure. Five surfaces were drawing it by hand at three bar heights,
 * three fills, three row paddings and three divider conventions, two of them on
 * the same page, which is exactly the duplication this directory exists to
 * prevent.
 *
 * It is not `Progress` and not `Meter`. Those two answer "how far through is
 * this?" and "how much of my allowance is gone?"; both are about one quantity
 * against a known ceiling, and both carry `progressbar`/`meter` semantics that
 * are wrong for a comparison between peers. This is a chart, so it is a list
 * with the numbers in it — which is also what makes it readable with the bars
 * turned off, on a screen reader, and in print.
 *
 * ## Why the plot is capped
 *
 * The first version put a full-width 6px bar under a `justify-between` row, so
 * on a 1,900px card four solid ink rules ran the whole width of the panel and
 * the label sat about 1,500px from its own figure: it read as newspaper rules
 * rather than as data, and no reader binds a label to a number a screen apart.
 * The row's contents are now capped at `--container-pair` and sit label · bar ·
 * figure, adjacent, while the hover and selection band still runs the full width
 * of the card — the control is the row, the chart is not.
 *
 * The bar itself is `aria-hidden`: the row already states its label and its
 * value in text, and announcing the geometry a second time adds nothing.
 */
export function RankedBars({
  items,
  max,
  label,
  tone = 'data',
  loading = false,
  loadingRows = 5,
  emptyTitle: emptyTitleProp,
  emptyDescription,
  className,
}: RankedBarsProps) {
  const { t } = useTranslation();
  // `??` would also swallow an explicit `null`; a default parameter
  // only applies to `undefined`, and callers pass null to opt OUT.
  const emptyTitle = emptyTitleProp === undefined ? (t('ds.nothingToRankYet') || 'Nothing to rank yet') : emptyTitleProp;
  if (loading) return <LoadingBars rows={loadingRows} className={className} />;

  // An empty `<ol>` is a blank area with no message, on a surface whose system
  // requires four states everywhere.
  if (items.length === 0) {
    return (
      <EmptyState size="inline" title={emptyTitle} description={emptyDescription} className={className} />
    );
  }

  const ceiling = max ?? items.reduce((highest, item) => Math.max(highest, item.value), 0);

  return (
    <ol aria-label={label} className={cn('flex flex-col', className)}>
      {items.map((item) => {
        // A zero ceiling means every value is zero. Draw nothing rather than
        // dividing by it and painting every row full.
        const share = ceiling > 0 ? Math.min(100, (Math.max(0, item.value) / ceiling) * 100) : 0;
        const body = (
          <>
            <div className="flex max-w-pair items-center gap-3">
              {/* The label carries more of the row than the bar does. It was
                  `flex-1` against the bar's `flex-[1.4]`, which gave a whole
                  visitor question 175px and its bar 245 — and the question is
                  the content. The bar is the *comparison*; the row already
                  states the number in text beside it. */}
              <span className="min-w-0 flex-[1.6] truncate text-sm text-text-primary">
                {item.label}
              </span>
              <div
                aria-hidden
                className="hidden h-2 min-w-16 flex-1 overflow-hidden rounded-xs bg-surface-sunken sm:block"
              >
                <div
                  className={cn('h-full rounded-xs transition-[width] duration-[var(--dur-slow)]', TONE_FILL[tone])}
                  style={{ width: `${share}%` }}
                />
              </div>
              {/* `min-w-16`, not `w-16`. A fixed 64px column holds "412" and
                  overflows at four digits, at a currency figure, and at the
                  `1,234 · 45%` display these rows are routinely given — the
                  text simply ran out of its own box. The minimum still lines
                  four rows of three-digit figures up on one right edge. */}
              {/* rtl-ok: numeric figure — digits stay right-aligned so place value lines up, regardless of direction */}
              <span className="figure min-w-16 shrink-0 whitespace-nowrap text-right text-sm font-medium text-text-primary">
                {item.display ?? item.value}
              </span>
            </div>
            {item.meta ? (
              <p className="mt-0.5 max-w-pair text-2xs text-text-tertiary">{item.meta}</p>
            ) : null}
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
                  'block w-full px-cell py-2.5 text-start transition-colors duration-[var(--dur-fast)]',
                  item.selected ? 'bg-accent-50' : 'hover:bg-surface-hover',
                )}
              >
                {body}
              </button>
            ) : (
              <div className="px-cell py-2.5">{body}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
