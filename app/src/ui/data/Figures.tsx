import { useId, type ReactNode } from 'react';
import { ArrowDown, ArrowRight, ArrowUp } from 'lucide-react';
import { cn } from '../lib/cn';
import { Skeleton } from '../primitives/Skeleton';
import { ABSENT } from '../lib/formatters';
import type { Tone } from '../primitives/Badge';

export type TrendDirection = 'up' | 'down' | 'flat';

export interface StatTileProps {
  label: string;
  /** Pre-formatted. Pass `undefined` for a value that does not exist. */
  value: string | undefined;
  /**
   * The window the figure covers, e.g. "Last 30 days".
   *
   * Required, because an unanchored number is not actionable: the old dashboard
   * showed "Conversations 1,204" over no stated period, and a card literally
   * titled "7-day performance" was rendering all-time figures. Inside a
   * `StatRow` the window is stated once for the strip and each tile suppresses
   * its own — see `periodInherited`.
   */
  period: string;
  /**
   * The comparison. Without one a figure is a receipt, not an instrument: the
   * reader cannot tell whether 412 conversations is good.
   *
   * `label` names what it is compared *against* — "vs previous 30 days" — and
   * is what makes the arrow mean anything. The direction is stated in the
   * accessible name as a word, because a coloured arrow is colour and shape
   * doing the work alone.
   */
  delta?: { value: string; direction: TrendDirection; label?: string };
  /**
   * Set when a rise is bad — bounce rate, response time, cost. Without it the
   * trend colour lies on every inverted metric.
   */
  invertTrend?: boolean;
  /**
   * Stands in for the *value* when there is none: "Not rated yet".
   *
   * Typeset as a phrase, not as a figure. It used to take the tile's whole
   * value treatment — `.figure`, `font-semibold`, `text-xl`, full ink — so
   * "Not rated yet" shouted louder than the `1,204` beside it, and a strip's
   * loudest tile was the one with no number in it.
   */
  empty?: string;
  /**
   * A sentence under the figure.
   *
   * A tile is a number, not a paragraph: an unbounded sentence under one tile in
   * a four-up row makes that tile taller than its three peers and breaks the
   * row's baseline. Keep it to a few words, or put it on the card instead.
   */
  hint?: string;
  loading?: boolean;
  tone?: Extract<Tone, 'neutral' | 'success' | 'warning' | 'danger'>;
  /**
   * `md` (18) is a metric. `lg` (22) is the metric a card is about. `hero` (28)
   * is the one number a page is about, and there should be one of those.
   *
   * `md` used to be 22 — the page-title rung — so 114 tiles shouted as loudly as
   * the `h1` above them and the headline figure had nowhere to go.
   */
  size?: 'md' | 'lg' | 'hero';
  /** Set by `StatRow`: the strip already states the window. */
  periodInherited?: boolean;
  className?: string;
}

const VALUE_TONE: Record<NonNullable<StatTileProps['tone']>, string> = {
  neutral: 'text-text-primary',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
};

const VALUE_SIZE: Record<NonNullable<StatTileProps['size']>, string> = {
  md: 'text-lg',
  lg: 'text-xl',
  hero: 'text-2xl',
};

const TREND_ICON = { up: ArrowUp, down: ArrowDown, flat: ArrowRight } as const;
const TREND_WORD = { up: 'up', down: 'down', flat: 'flat' } as const;

/**
 * One figure, named and anchored.
 *
 * The leaf, with no chrome of its own: a row of them belongs in a `StatRow`,
 * which owns the strip, the dividers and the one statement of the period. A
 * tile on its own inside a hand-written grid is how four numbers ended up
 * reading as four floating paragraphs separated by nothing but 24px of air.
 *
 * The label is 12px sentence case, not the mono uppercase `Eyebrow` it used to
 * be: 11px uppercase mono is the least legible combination in the system and it
 * was being spent on the *name of the number*, which is the thing the reader
 * scans first. `Eyebrow` is for card headers and column groups. The rule
 * DESIGN.md actually states — every figure is mono — is about the figure, and
 * the figure is still mono.
 */
export function StatTile({
  label,
  value,
  period,
  delta,
  invertTrend = false,
  empty,
  hint,
  loading = false,
  tone = 'neutral',
  size = 'md',
  periodInherited = false,
  className,
}: StatTileProps) {
  const TrendIcon = delta ? TREND_ICON[delta.direction] : null;
  const good = delta
    ? delta.direction === 'flat'
      ? null
      : (delta.direction === 'up') !== invertTrend
    : null;
  const shown = value ?? empty ?? ABSENT;
  // A non-answer is a sentence. Only a real value is a figure.
  const isPhrase = value === undefined && Boolean(empty);

  return (
    <div className={cn('min-w-0', className)}>
      <p className="truncate text-xs font-medium text-text-secondary">{label}</p>
      {loading ? (
        <Skeleton className={cn('mt-2', size === 'md' ? 'h-6 w-20' : 'h-8 w-24')} />
      ) : (
        <p
          className={cn(
            'mt-1.5',
            isPhrase
              ? 'text-base text-text-tertiary'
              : cn('figure font-semibold', VALUE_SIZE[size]),
            value === undefined && !empty ? 'text-text-tertiary' : !isPhrase && VALUE_TONE[tone],
          )}
        >
          {shown}
        </p>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
        {delta && TrendIcon && !loading ? (
          <span
            className={cn(
              'figure inline-flex items-center gap-0.5 font-medium',
              good === null ? 'text-text-tertiary' : good ? 'text-success' : 'text-danger',
            )}
          >
            <TrendIcon aria-hidden className="h-3 w-3" />
            {delta.value}
            {/* The direction as a word. An arrow plus a colour is shape and hue
                carrying the whole meaning, which DESIGN.md §1.4 forbids — and a
                screen reader announces neither. */}
            <span className="sr-only">
              {' '}
              {TREND_WORD[delta.direction]}
              {delta.label ? ` ${delta.label}` : ''}
            </span>
          </span>
        ) : null}
        {delta?.label ? (
          <span aria-hidden className="text-text-tertiary">
            {delta.label}
          </span>
        ) : null}
        {periodInherited ? null : <span className="text-text-tertiary">{period}</span>}
      </div>
      {hint ? <p className="mt-1 text-xs text-text-secondary">{hint}</p> : null}
    </div>
  );
}

export interface StatRowProps {
  /**
   * The window every tile in the strip covers, stated once.
   *
   * It used to be stated per tile, so "Last 30 days" printed four times in a row
   * — four lines of grey type carrying one fact. A tile that genuinely differs
   * ("Right now", "All time") still states its own, which is the case the
   * required prop existed for.
   */
  period: string;
  items: readonly (Omit<StatTileProps, 'period'> & { period?: string })[];
  /** 2–5 tiles. Past five it is a table, not a row. */
  columns?: 2 | 3 | 4 | 5;
  loading?: boolean;
  /** Names the strip for assistive tech, e.g. "Conversation volume". */
  label?: string;
  className?: string;
}

const STAT_COLUMNS: Record<NonNullable<StatRowProps['columns']>, string> = {
  2: 'grid-cols-1 sm:grid-cols-2',
  3: 'grid-cols-1 sm:grid-cols-3',
  4: 'grid-cols-2 lg:grid-cols-4',
  5: 'grid-cols-2 lg:grid-cols-5',
};

/**
 * A strip of figures, hairline-divided.
 *
 * Four surfaces hand-wrote `grid grid-cols-2 gap-6 lg:grid-cols-4` with no
 * dividers, which is a paragraph of numbers rather than an instrument panel:
 * 24px of air is the only thing separating one metric from the next, and the
 * eye reads them as a run of text. Stripe and Razorpay both hairline-divide a
 * KPI strip for exactly this reason.
 *
 * Rendered flush — put it in a `CardBody flush` — so the tiles reach the card's
 * edges and their dividers meet its border instead of stopping 20px short.
 *
 * The dividers are drawn as a top and left hairline on every cell, pulled back
 * a pixel and clipped by the container. That is the one construction that stays
 * correct when the strip wraps: `divide-x` gives the first cell of the second
 * row a left border it should not have, and no combination of `nth-child`
 * resets survives the breakpoint changing the row length.
 *
 * ## The window is stated, once, by the strip
 *
 * `StatTile.period` is required precisely so a figure can never be unanchored,
 * and this component sets `periodInherited` on every tile it owns — which
 * *suppresses* the tile's own line. It then printed nothing in its place, so a
 * strip's window was stated **nowhere**: four numbers over no period at all,
 * which is the exact defect the required prop exists to prevent. Three separate
 * surfaces worked around it by re-stating the window in a `CardHeader` eyebrow.
 *
 * It is now a caption under the strip, hairline-separated and stated once, and
 * the grid is `aria-describedby` it so the window is part of what the strip
 * announces rather than a loose line of grey type after it. A tile that
 * genuinely covers a different window ("Right now", "All time") still prints
 * its own, and the caption is dropped entirely when every tile does.
 */
export function StatRow({ period, items, columns = 4, loading = false, label, className }: StatRowProps) {
  const captionId = useId();
  // Only tiles that actually inherit. A strip whose every tile states its own
  // window would otherwise carry a caption contradicted by all four of them.
  const inherits = items.some((item) => item.period === undefined || item.period === period);

  return (
    <div className={cn('min-w-0', className)}>
      <div
        role={label ? 'group' : undefined}
        aria-label={label}
        aria-describedby={inherits ? captionId : undefined}
        className={cn('grid overflow-hidden', STAT_COLUMNS[columns])}
      >
        {items.map((item) => (
          <div
            key={item.label}
            className="-ml-px -mt-px border-l border-t border-border px-cell py-4"
          >
            <StatTile
              {...item}
              period={item.period ?? period}
              periodInherited={item.period === undefined || item.period === period}
              loading={loading || item.loading}
            />
          </div>
        ))}
      </div>
      {inherits ? (
        <p id={captionId} className="border-t border-border px-cell py-2 text-xs text-text-tertiary">
          {period}
        </p>
      ) : null}
    </div>
  );
}

/** A label/value pair in a breakdown list. Always inside a `FigureList`. */
export function FigureRow({
  label,
  value,
  hint,
  /** Draws a rule above and bolds the row. For a total. */
  emphasis = false,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  hint?: string;
  emphasis?: boolean;
  tone?: NonNullable<StatTileProps['tone']>;
}) {
  return (
    <div
      className={cn(
        'flex items-baseline justify-between gap-4 py-2',
        emphasis && 'border-t border-border pt-2.5',
      )}
    >
      <dt className="min-w-0 text-xs text-text-secondary">
        {label}
        {hint ? (
          <span className="mt-0.5 block text-2xs text-text-tertiary">{hint}</span>
        ) : null}
      </dt>
      <dd
        className={cn(
          'figure shrink-0 text-right text-sm',
          emphasis ? 'font-semibold' : 'font-medium',
          VALUE_TONE[tone],
        )}
      >
        {value}
      </dd>
    </div>
  );
}

/**
 * The `dl` a `FigureRow` belongs in.
 *
 * A `dt`/`dd` pair outside a `dl` is invalid HTML and announces as loose text;
 * every caller was wrapping these in a bare `<dl>` by hand, on its honour.
 * `--container-pair` caps the row, because a label and its figure stretched
 * across a 1,400px card are a pair the eye can no longer bind.
 */
export function FigureList({ children, className }: { children: ReactNode; className?: string }) {
  return <dl className={cn('max-w-pair', className)}>{children}</dl>;
}

export interface DefinitionListProps {
  items: readonly { label: string; value: ReactNode }[];
  columns?: 1 | 2;
  /**
   * `stacked` puts the label above its value; `inline` puts it in a fixed left
   * column with the value beside it and a hairline between rows.
   *
   * `inline` is what a record panel wants and is roughly 32px per property
   * against `stacked`'s 35 — but the real difference is that the values form a
   * column the eye can run down, instead of alternating label/value/label/value
   * as unstructured text. A ten-property record stacked is 350px of prose
   * produced by the very component meant to replace prose.
   */
  layout?: 'stacked' | 'inline';
  className?: string;
}

/**
 * A record's fields, as a description list.
 *
 * Real `dl`/`dt`/`dd` so a screen reader pairs each value with its own label —
 * a two-column grid of loose divs reads as an undifferentiated run of text.
 *
 * **`PropertyGrid` in `src/ui/layout/` is where this is going.** It is the same
 * idea with room for a per-row action, a note on the label, and a density that
 * follows the page — and it is being built alongside this. `layout="inline"`
 * exists so the 22 surfaces on this component can adopt the shape now and move
 * across in one mechanical pass rather than two.
 */
export function DefinitionList({
  items,
  columns = 1,
  layout = 'stacked',
  className,
}: DefinitionListProps) {
  if (layout === 'inline') {
    return (
      <dl
        className={cn(
          'divide-y divide-border',
          // The two-column form is deliberately not a container query yet: `Card`
          // does not declare a container, so `@md/card` would never match and a
          // two-column list would silently collapse to one. It stays a viewport
          // query until the layout layer lands — noted here rather than fixed
          // silently, because a 320px inbox pane on a 1440px screen *is* the bug.
          columns === 2 && 'sm:grid sm:grid-cols-2 sm:gap-x-8 sm:divide-y-0 sm:[&>div]:border-b',
          className,
        )}
      >
        {items.map((item) => (
          <div
            key={item.label}
            className="grid grid-cols-[minmax(6rem,9rem)_minmax(0,1fr)] items-baseline gap-x-4 border-border py-2"
          >
            <dt className="text-xs text-text-secondary">{item.label}</dt>
            <dd className="min-w-0 break-words text-sm text-text-primary">{item.value ?? ABSENT}</dd>
          </div>
        ))}
      </dl>
    );
  }

  return (
    <dl className={cn('grid gap-x-6 gap-y-3', columns === 2 && 'sm:grid-cols-2', className)}>
      {items.map((item) => (
        <div key={item.label} className="min-w-0">
          <dt className="text-xs text-text-tertiary">{item.label}</dt>
          <dd className="mt-0.5 break-words text-sm text-text-primary">{item.value ?? ABSENT}</dd>
        </div>
      ))}
    </dl>
  );
}
