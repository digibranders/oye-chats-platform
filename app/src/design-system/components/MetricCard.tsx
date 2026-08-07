import { type ReactNode } from 'react';
import { Minus, TrendingDown, TrendingUp, type LucideIcon } from 'lucide-react';
import { cn } from '../lib/cn';

export type MetricTrend = 'up' | 'down' | 'flat';

export interface MetricCardProps {
  /** Short metric name, e.g. "Conversations". */
  label: string;
  /** The headline figure. Pre-formatted by the caller (e.g. "1,284", "98%"). */
  value: ReactNode;
  /** Change indicator, e.g. "+12%" or "3 fewer". Pairs with `trend` for color. */
  delta?: string;
  /** Direction of `delta`. Drives arrow + color: up=positive, down=negative. */
  trend?: MetricTrend;
  /** Neutral supporting line under the value, e.g. "12 credits". */
  caption?: string;
  /** Optional leading glyph. */
  icon?: LucideIcon;
  /** Adds a hover border lift, signalling a living metric. */
  interactive?: boolean;
  /** Visual density. `sm` = sleeker padding + smaller value type for scan rows. */
  size?: 'sm' | 'md';
  className?: string;
}

const trendStyles: Record<MetricTrend, { icon: LucideIcon; text: string }> = {
  up: { icon: TrendingUp, text: 'text-[var(--ds-success)]' },
  down: { icon: TrendingDown, text: 'text-[var(--ds-danger)]' },
  flat: { icon: Minus, text: 'text-[var(--ds-text-muted)]' },
};

/**
 * MetricCard - a single KPI tile (mandate shared component). One number, its
 * label, and an optional trend delta or caption. Compose several in a
 * responsive grid to build a stats row.
 *
 * Deliberately compact: a stats row is scanned, not read, so the tile spends
 * its height on the number and nothing else. The icon is a bare glyph rather
 * than a tinted chip - the chip set the row height on its own and added
 * decoration a number tile doesn't need.
 */
export function MetricCard({
  label,
  value,
  delta,
  trend,
  caption,
  icon: Icon,
  interactive = false,
  size = 'md',
  className,
}: MetricCardProps) {
  const isSm = size === 'sm';
  const trendStyle = trend ? trendStyles[trend] : null;
  const TrendIcon = trendStyle?.icon;

  // The value row carries exactly one secondary figure. A delta outranks a
  // caption there; a caption only claims its own line when both are supplied.
  const deltaNode =
    delta && trendStyle && TrendIcon ? (
      <span
        className={cn('flex shrink-0 items-center gap-1 text-[12px] font-semibold', trendStyle.text)}
      >
        <TrendIcon size={13} aria-hidden="true" />
        {delta}
      </span>
    ) : null;

  return (
    <div
      className={cn(
        'rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] shadow-[var(--ds-shadow-sm)]',
        isSm ? 'px-3 py-2.5' : 'p-4',
        interactive && 'transition-colors hover:border-[var(--ds-border-strong)]',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <p
          className={cn(
            'truncate font-medium text-[var(--ds-text-muted)]',
            isSm ? 'text-[11px]' : 'text-[12px]',
          )}
        >
          {label}
        </p>
        {Icon && (
          <Icon
            size={isSm ? 12 : 14}
            aria-hidden="true"
            className="shrink-0 text-[var(--ds-text-subtle)]"
          />
        )}
      </div>
      <div className={cn('flex items-baseline justify-between gap-2', isSm ? 'mt-1' : 'mt-2')}>
        <span
          className={cn(
            'font-semibold leading-none tracking-tight tabular-nums text-[var(--ds-text)]',
            isSm ? 'text-[15px]' : 'text-[20px]',
          )}
        >
          {value}
        </span>
        {deltaNode ??
          (caption && (
            <span className="shrink-0 text-[12px] tabular-nums text-[var(--ds-text-subtle)]">
              {caption}
            </span>
          ))}
      </div>
      {deltaNode && caption && (
        <p className="mt-1.5 truncate text-[12px] tabular-nums text-[var(--ds-text-subtle)]">
          {caption}
        </p>
      )}
    </div>
  );
}
