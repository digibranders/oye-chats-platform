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
  /** Optional leading glyph. */
  icon?: LucideIcon;
  className?: string;
}

const trendStyles: Record<MetricTrend, { icon: LucideIcon; text: string }> = {
  up: { icon: TrendingUp, text: 'text-[var(--ds-success)]' },
  down: { icon: TrendingDown, text: 'text-[var(--ds-danger)]' },
  flat: { icon: Minus, text: 'text-[var(--ds-text-muted)]' },
};

/**
 * MetricCard - a single KPI tile (mandate shared component). One number, its
 * label, and an optional trend delta. Compose several in a responsive grid to
 * build a stats row.
 */
export function MetricCard({ label, value, delta, trend, icon: Icon, className }: MetricCardProps) {
  const trendStyle = trend ? trendStyles[trend] : null;
  const TrendIcon = trendStyle?.icon;

  return (
    <div
      className={cn(
        'rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] p-5 shadow-[var(--ds-shadow-sm)]',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-[13px] font-medium text-[var(--ds-text-muted)]">{label}</p>
        {Icon && (
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--ds-bg-sunken)] text-[var(--ds-text-subtle)]">
            <Icon size={16} aria-hidden="true" />
          </span>
        )}
      </div>
      <div className="mt-3 flex items-end justify-between gap-3">
        <span className="text-2xl font-bold tracking-tight text-[var(--ds-text)]">{value}</span>
        {delta && trendStyle && TrendIcon && (
          <span className={cn('flex items-center gap-1 text-[13px] font-semibold', trendStyle.text)}>
            <TrendIcon size={14} aria-hidden="true" />
            {delta}
          </span>
        )}
      </div>
    </div>
  );
}
