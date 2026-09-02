import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipProps,
} from 'recharts';
import {
  CHART_AXIS,
  CHART_CURSOR,
  CHART_GRID,
  CHART_MARGIN,
  ChartDataTable,
  ChartFrame,
  ChartLegend,
  ChartTooltip,
  formatNumber,
  seriesColor,
} from '../../ui';
import { type FeedbackTrendPoint } from './feedback-helpers';

/** The one series on this chart. */
const RATE_SERIES = 0;

function TrendTooltip({ active, payload }: TooltipProps<number, string>) {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0]?.payload as FeedbackTrendPoint | undefined;
  if (!point) return null;
  return (
    <ChartTooltip
      label={point.date}
      rows={[
        { name: 'Helpful share', value: `${point.rate}%`, seriesIndex: RATE_SERIES },
        {
          name: point.total === 1 ? 'Rating' : 'Ratings',
          value: formatNumber(point.total),
        },
      ]}
    />
  );
}

export interface FeedbackTrendChartProps {
  /**
   * The days actually plotted.
   *
   * `buildTrend` keeps only days that carry a rating and caps the result at the
   * most recent fortnight, so this is very often a subset of `rangeLabel`'s
   * window and never a day more than fourteen.
   */
  points: readonly FeedbackTrendPoint[];
  /** "Last 30 days". Names the window the ratings were drawn from. */
  rangeLabel: string;
  /**
   * Helpful share across the whole window, 0-100.
   *
   * Over `rangeLabel`, NOT over `points`: it counts every rating in the window,
   * including the ones on days the cap left off the axis. That is why the dashed
   * line it draws can sit above or below every point on the chart, and why
   * neither the summary nor the legend calls it the average of what is plotted.
   */
  overallRate: number;
  loading?: boolean;
}

/**
 * How the helpful share moved, day by day.
 *
 * The chart it replaces carried `role="img"` and a one-line label that named
 * the number of days and nothing else, so the only thing it existed to show —
 * where the line went — was unavailable to anyone not looking at it. `ChartFrame`
 * requires a summary that states the shape, and takes the same numbers as a
 * table underneath.
 *
 * It also drew itself in violet off a legacy `useTheme` palette that no other
 * chart in the app has used since the rebuild. One palette, one colour per
 * series, everywhere.
 */
export function FeedbackTrendChart({
  points,
  rangeLabel,
  overallRate,
  loading = false,
}: FeedbackTrendChartProps) {
  const first = points[0];
  const last = points[points.length - 1];
  const worst = points.reduce<FeedbackTrendPoint | null>(
    (lowest, point) => (lowest === null || point.rate < lowest.rate ? point : lowest),
    null,
  );

  const movement =
    points.length > 1 && first && last
      ? ` It started at ${first.rate}% on ${first.date} and ended at ${last.rate}% on ${last.date}.`
      : '';
  const trough =
    worst && points.length > 1 ? ` The lowest day was ${worst.date}, at ${worst.rate}%.` : '';
  /**
   * What is on the axis, said exactly.
   *
   * It used to say "by day, over last 90 days", which the chart cannot do:
   * `buildTrend` plots only days that carry a rating and stops at the most
   * recent fourteen of those, so a 90-day window routinely draws a fortnight.
   * The dashed line was called "the window's average", which is a second
   * claim the picture does not support, it is the rate over every rating in
   * the window, so on a workspace whose last fortnight went badly it sits
   * above every point drawn, and a reader was left to conclude the chart was
   * broken.
   */
  const plotted =
    points.length === 1
      ? 'on the one day in it that carries a rating'
      : `on the ${points.length} most recent days in it that carry a rating, fourteen at most`;
  const summary =
    `The share of answers rated helpful, drawn from ${rangeLabel.toLowerCase()}, ${plotted}.`
    + `${movement}${trough}`
    + ` The dashed line is the ${overallRate}% helpful share over the whole window,`
    + ' counted across every rating in it rather than across the days plotted,'
    + ' so it can sit outside them.';

  return (
    <ChartFrame
      height={220}
      loading={loading}
      // Fewer than two days is not a trend: one point draws a lone dot under a
      // heading that promises movement. The tiles above already state the
      // single day's figure, so the honest answer here is to say so.
      empty={points.length < 2}
      emptyTitle="Not enough ratings to plot"
      emptyDescription="A trend needs ratings on more than one day. Once visitors have rated answers across a few days, the line appears here."
      summary={summary}
      legend={
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <ChartLegend items={[{ label: 'Helpful share', seriesIndex: RATE_SERIES }]} />
          {/* The dashed line, named in words. `ChartLegend`'s marker is a
              filled dot on a series colour, which cannot stand for a grey
              dashed rule, flagged for the system rather than faked here.

              "Over the window", not "the average": it is the share across every
              rating in the range, and the plotted days are a capped subset of
              those, so calling it the average of the line was a claim the chart
              contradicts whenever the two differ. */}
          <p className="text-xs text-text-secondary">
            Dashed: helpful share over {rangeLabel.toLowerCase()},{' '}
            <span className="figure font-medium text-text-primary">{overallRate}%</span>
          </p>
        </div>
      }
      dataTable={
        <ChartDataTable
          caption="Helpful share by day"
          columns={[
            { key: 'day', header: 'Day' },
            { key: 'rate', header: 'Helpful share', numeric: true },
            { key: 'total', header: 'Ratings', numeric: true },
          ]}
          rowKey={(_row, index) => `${points[index].date}-${index}`}
          rows={points.map((point) => ({
            day: point.date,
            rate: `${point.rate}%`,
            total: formatNumber(point.total),
          }))}
        />
      }
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={[...points]} margin={CHART_MARGIN}>
          <CartesianGrid {...CHART_GRID} />
          <XAxis dataKey="date" {...CHART_AXIS} minTickGap={24} />
          <YAxis
            {...CHART_AXIS}
            width={44}
            domain={[0, 100]}
            tickFormatter={(value: number) => `${value}%`}
          />
          {/* The window's own average, so a day is read against the period it
              sits in rather than against the top of the axis.

              The line carries no label of its own. `insideTopRight` places the
              text against the plot's edge, and a workspace whose average is 0%
              — every answer marked unhelpful, which is exactly when someone
              opens this tab — put "Average 0%" straight on top of the last date
              on the x-axis. The figure is in the legend under the plot, where it
              cannot collide with anything and is legible at any average. */}
          <ReferenceLine
            y={overallRate}
            stroke="var(--color-border-strong)"
            strokeDasharray="4 3"
          />
          <Tooltip content={<TrendTooltip />} cursor={CHART_CURSOR} />
          <Line
            type="monotone"
            dataKey="rate"
            name="Helpful share"
            stroke={seriesColor(RATE_SERIES)}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
