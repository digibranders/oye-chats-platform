import { type ReactNode } from 'react';
import { cn } from '../lib/cn';
import { EmptyState, ErrorState } from '../data/States';
import { Skeleton } from '../primitives/Skeleton';
import { seriesColor } from './theme';

/** Uneven on purpose: a row of equal bars reads as a rendering fault. */
const CHART_SKELETON_HEIGHTS = ['h-[45%]', 'h-[70%]', 'h-[35%]', 'h-[85%]', 'h-[55%]', 'h-[65%]'] as const;

export interface ChartFrameProps {
  /** The chart itself, usually a Recharts `ResponsiveContainer`. */
  children: ReactNode;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  /** True when there is genuinely nothing to plot, as opposed to a failure. */
  empty?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  height?: number;
  /**
   * A text equivalent of the plotted data.
   *
   * Required, and not optional, because a chart is a picture: SVG marked
   * `aria-hidden` with no alternative makes the whole series unavailable to
   * anyone not looking at it. The previous app's trend chart was `aria-hidden`
   * with only total/average/peak beside it, so the shape of the series — the
   * only thing the chart was for — could not be read at all.
   */
  summary: string;
  /** A `<table>` of the same data, revealed by the "View as table" control. */
  dataTable?: ReactNode;
  className?: string;
}

/**
 * The shell every chart sits in: fixed height, the four states, and the
 * accessible alternative.
 *
 * Charts do not own their own loading or empty handling. Letting each one decide
 * is why the old app had panels that vanished entirely on error, panels that
 * showed "no activity in this period" for an outage, and a grid that collapsed
 * to one column whenever a neighbour returned nothing.
 */
export function ChartFrame({
  children,
  loading = false,
  error = null,
  onRetry,
  empty = false,
  emptyTitle = 'Nothing to plot yet',
  emptyDescription,
  height = 240,
  summary,
  dataTable,
  className,
}: ChartFrameProps) {
  return (
    <div className={className}>
      <div style={{ height }} className="relative w-full">
        {loading ? (
          // A bar-shaped skeleton rather than one grey slab, so the space
          // reads as "a chart is arriving" and does not jump when it does.
          <div aria-busy className="flex h-full items-end gap-2 px-2 pb-6">
            {CHART_SKELETON_HEIGHTS.map((height, index) => (
              <Skeleton key={index} className={cn('flex-1 rounded-sm', height)} />
            ))}
          </div>
        ) : error ? (
          <ErrorState compact description={error} onRetry={onRetry} />
        ) : empty ? (
          <EmptyState compact title={emptyTitle} description={emptyDescription} />
        ) : (
          <>
            {/* The picture, hidden from assistive tech, and the words that
                replace it. Both always render — the summary is not a fallback. */}
            <div aria-hidden className="h-full w-full">
              {children}
            </div>
            <p className="sr-only">{summary}</p>
          </>
        )}
      </div>

      {dataTable && !loading && !error && !empty ? (
        <details className="mt-2 border-t border-border pt-2">
          <summary className="cursor-pointer text-xs text-text-secondary hover:text-text-primary">
            View as table
          </summary>
          <div className="mt-2 overflow-x-auto">{dataTable}</div>
        </details>
      ) : null}
    </div>
  );
}

export interface ChartLegendItem {
  label: string;
  /** Index into the shared series palette. */
  seriesIndex: number;
  value?: string;
}

/** A legend that names each series and, where useful, its current figure. */
export function ChartLegend({ items, className }: { items: readonly ChartLegendItem[]; className?: string }) {
  return (
    <ul className={cn('flex flex-wrap items-center gap-x-4 gap-y-1.5', className)}>
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5 text-xs text-text-secondary">
          <span
            aria-hidden
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: seriesColor(item.seriesIndex) }}
          />
          {item.label}
          {item.value ? <span className="figure font-medium text-text-primary">{item.value}</span> : null}
        </li>
      ))}
    </ul>
  );
}
