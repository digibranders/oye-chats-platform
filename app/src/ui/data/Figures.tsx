import { type ReactNode } from 'react';
import { ArrowDown, ArrowRight, ArrowUp } from 'lucide-react';
import { cn } from '../lib/cn';
import { Eyebrow } from '../primitives/Misc';
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
   * titled "7-day performance" was rendering all-time figures.
   */
  period: string;
  delta?: { value: string; direction: TrendDirection };
  /**
   * Set when a rise is bad — bounce rate, response time, cost. Without it the
   * trend colour lies on every inverted metric.
   */
  invertTrend?: boolean;
  hint?: string;
  loading?: boolean;
  tone?: Extract<Tone, 'neutral' | 'success' | 'warning' | 'danger'>;
  size?: 'md' | 'lg';
  className?: string;
}

const VALUE_TONE: Record<NonNullable<StatTileProps['tone']>, string> = {
  neutral: 'text-text-primary',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
};

const TREND_ICON = { up: ArrowUp, down: ArrowDown, flat: ArrowRight } as const;

export function StatTile({
  label,
  value,
  period,
  delta,
  invertTrend = false,
  hint,
  loading = false,
  tone = 'neutral',
  size = 'md',
  className,
}: StatTileProps) {
  const TrendIcon = delta ? TREND_ICON[delta.direction] : null;
  const good = delta
    ? delta.direction === 'flat'
      ? null
      : (delta.direction === 'up') !== invertTrend
    : null;

  return (
    <div className={cn('min-w-0', className)}>
      <Eyebrow>{label}</Eyebrow>
      {loading ? (
        <Skeleton className={cn('mt-2', size === 'lg' ? 'h-8 w-24' : 'h-6 w-20')} />
      ) : (
        <p
          className={cn(
            'tnum mt-1.5 font-semibold leading-tight',
            size === 'lg' ? 'text-2xl' : 'text-xl',
            VALUE_TONE[tone],
          )}
        >
          {value ?? ABSENT}
        </p>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
        {delta && TrendIcon && !loading ? (
          <span
            className={cn(
              'inline-flex items-center gap-0.5 font-medium tnum',
              good === null ? 'text-text-tertiary' : good ? 'text-success' : 'text-danger',
            )}
          >
            <TrendIcon aria-hidden className="h-3 w-3" />
            {delta.value}
          </span>
        ) : null}
        <span className="text-text-tertiary">{period}</span>
      </div>
      {hint ? <p className="mt-1 text-xs leading-snug text-text-secondary">{hint}</p> : null}
    </div>
  );
}

/** A label/value pair in a breakdown list. */
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
          <span className="mt-0.5 block text-2xs leading-snug text-text-tertiary">{hint}</span>
        ) : null}
      </dt>
      <dd
        className={cn(
          'tnum shrink-0 text-right text-sm',
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
 * A record's fields, as a description list.
 *
 * Real `dl`/`dt`/`dd` so a screen reader pairs each value with its own label —
 * a two-column grid of loose divs reads as an undifferentiated run of text.
 */
export function DefinitionList({
  items,
  columns = 1,
  className,
}: {
  items: readonly { label: string; value: ReactNode }[];
  columns?: 1 | 2;
  className?: string;
}) {
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
