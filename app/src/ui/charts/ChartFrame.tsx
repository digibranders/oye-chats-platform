import { type ReactNode } from 'react';
import { cn } from '../lib/cn';
import { EmptyState, ErrorState } from '../data/States';
import { Disclosure } from '../layout/Disclosure';
import { Skeleton } from '../primitives/Skeleton';
import { seriesColor } from './theme';
import { useTranslation } from '../../i18n/useTranslation';
import { t as translateNow } from '../../i18n/i18n';

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
  /**
   * The key to the series, rendered directly under the plot.
   *
   * It has to live inside the frame. Passed as a sibling *after* `ChartFrame` —
   * which is what one analytics chart did — the painted order becomes chart,
   * horizontal rule, "View as table", legend: the key to the two lines ends up
   * below a divider and below an unrelated control, which is the one place a
   * legend must never be.
   */
  legend?: ReactNode;
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
 *
 * The height box centres whatever is in it. It used to be a plain block, so a
 * failed panel rendered its ~120px notice at the top of a 240px box with 120px
 * of nothing under it — and six panels failing at once made six lopsided boxes.
 */
export function ChartFrame({
  children,
  loading = false,
  error = null,
  onRetry,
  empty = false,
  emptyTitle: emptyTitleProp,
  emptyDescription,
  height = 240,
  summary,
  legend,
  dataTable,
  className,
}: ChartFrameProps) {
  const { t } = useTranslation();
  // `??` would also swallow an explicit `null`; a default parameter
  // only applies to `undefined`, and callers pass null to opt OUT.
  const emptyTitle = emptyTitleProp === undefined ? (t('ds.nothingToPlotYet') || 'Nothing to plot yet') : emptyTitleProp;
  const plotted = !loading && !error && !empty;

  return (
    <div className={className}>
      <div
        style={{ height }}
        className="relative flex w-full items-center justify-center"
      >
        {loading ? (
          // A bar-shaped skeleton rather than one grey slab, so the space
          // reads as "a chart is arriving" and does not jump when it does.
          <div aria-busy className="flex h-full w-full items-end gap-2 px-2 pb-6">
            {CHART_SKELETON_HEIGHTS.map((barHeight, index) => (
              <Skeleton key={index} className={cn('flex-1 rounded-xs', barHeight)} />
            ))}
          </div>
        ) : error ? (
          <ErrorState size="inline" align="center" description={error} onRetry={onRetry} />
        ) : empty ? (
          <EmptyState size="inline" align="center" title={emptyTitle} description={emptyDescription} />
        ) : (
          <>
            {/* The picture, hidden from assistive tech, and the words that
                replace it. Both always render — the summary is not a fallback.
                LTR island: a plotted axis reads left to right regardless of
                the console's own language, the same convention as a numeric
                `.figure` column, so this is `dir="ltr"` rather than mirrored -
                only the labels and legend around it follow the console's
                direction. */}
            <div aria-hidden dir="ltr" className="h-full w-full">
              {children}
            </div>
            <p className="sr-only">{summary}</p>
          </>
        )}
      </div>

      {legend && plotted ? <div className="mt-2">{legend}</div> : null}

      {dataTable && plotted ? (
        // `Disclosure`, not a native `<details>`. The native element is reserved
        // in this system for content that must stay findable by the browser's
        // own in-page search while collapsed — a stack trace — and using it here
        // gave the console two disclosure affordances, a chevron and the
        // browser's own triangle, on adjacent surfaces.
        <div className="mt-2 border-t border-border pt-2">
          <Disclosure
            summary={<span className="text-xs text-text-secondary">
                {translateNow('ds.viewAsTable') || 'View as table'}
              </span>}
            regionLabel={translateNow('ds.summaryAsATable', { summary }) || `${summary} as a table`}
            panelClassName="overflow-x-auto"
          >
            {dataTable}
          </Disclosure>
        </div>
      ) : null}
    </div>
  );
}

export interface ChartLegendItem {
  label: string;
  /** Index into the shared series palette. */
  seriesIndex: number;
  value?: string;
  /**
   * What this entry actually is, drawn as it is drawn in the plot.
   *
   * A filled dot was the only marker, so a **reference line** — an average, a
   * plan limit, a target — had no legal entry: describing a 1px dashed rule with
   * a solid disc is the legend telling the reader the wrong thing about the
   * chart it is explaining. `line` is a solid rule, `dash` a dashed one, and
   * they are the same width as the mark they stand for.
   */
  marker?: 'dot' | 'line' | 'dash';
}

const MARKER: Record<NonNullable<ChartLegendItem['marker']>, string> = {
  dot: 'h-2 w-2 rounded-full',
  line: 'h-0.5 w-4 rounded-full',
  // A real gap rather than a dashed border: a 2px-tall element cannot show a
  // border-style, so the dashes are painted with a repeating gradient.
  dash: 'h-0.5 w-4 rounded-full',
};

/** A legend that names each series and, where useful, its current figure. */
export function ChartLegend({ items, className }: { items: readonly ChartLegendItem[]; className?: string }) {
  return (
    <ul className={cn('flex flex-wrap items-center gap-x-4 gap-y-1.5', className)}>
      {items.map((item) => {
        const marker = item.marker ?? 'dot';
        const colour = seriesColor(item.seriesIndex);
        return (
          <li key={item.label} className="flex items-center gap-1.5 text-xs text-text-secondary">
            <span
              aria-hidden
              className={cn('shrink-0', MARKER[marker])}
              style={
                marker === 'dash'
                  ? {
                      backgroundImage: `repeating-linear-gradient(to right, ${colour} 0 4px, transparent 4px 7px)`,
                    }
                  : { backgroundColor: colour }
              }
            />
            {item.label}
            {item.value ? (
              <span className="figure font-medium text-text-primary">{item.value}</span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
