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
  CHART_GRID,
  CHART_MARGIN,
  ChartFrame,
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
    <div className="rounded-md border border-border bg-surface px-2.5 py-2 shadow-md">
      <p className="text-2xs text-text-tertiary">{point.date}</p>
      <p className="figure text-xs text-text-primary">{point.rate}% helpful</p>
      <p className="figure text-2xs text-text-secondary">
        {formatNumber(point.total)} {point.total === 1 ? 'rating' : 'ratings'}
      </p>
    </div>
  );
}

export interface FeedbackTrendChartProps {
  points: readonly FeedbackTrendPoint[];
  /** "Last 30 days". Names the window in the summary sentence. */
  rangeLabel: string;
  /** Helpful share across the whole window, 0-100. */
  overallRate: number;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
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
  error = null,
  onRetry,
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
  const summary = `The share of answers rated helpful, by day, over ${rangeLabel.toLowerCase()}: ${overallRate}% across the whole window.${movement}${trough}`;

  return (
    <ChartFrame
      height={220}
      loading={loading}
      error={error}
      onRetry={onRetry}
      // Fewer than two days is not a trend: one point draws a lone dot under a
      // heading that promises movement. The tiles above already state the
      // single day's figure, so the honest answer here is to say so.
      empty={points.length < 2}
      emptyTitle="Not enough ratings to plot"
      emptyDescription="A trend needs ratings on more than one day. Once visitors have rated answers across a few days, the line appears here."
      summary={summary}
      dataTable={
        <table className="w-full text-left text-xs">
          <caption className="sr-only">Helpful share by day</caption>
          <thead>
            <tr className="text-text-tertiary">
              <th scope="col" className="py-1 pr-4 font-medium">
                Day
              </th>
              <th scope="col" className="py-1 pr-4 font-medium">
                Helpful share
              </th>
              <th scope="col" className="py-1 font-medium">
                Ratings
              </th>
            </tr>
          </thead>
          <tbody>
            {points.map((point, index) => (
              <tr key={`${point.date}-${index}`} className="border-t border-border">
                <th scope="row" className="py-1 pr-4 font-normal text-text-secondary">
                  {point.date}
                </th>
                <td className="figure py-1 pr-4 text-text-primary">{point.rate}%</td>
                <td className="figure py-1 text-text-secondary">{formatNumber(point.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
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
              sits in rather than against the top of the axis. */}
          <ReferenceLine
            y={overallRate}
            stroke="var(--color-border-strong)"
            strokeDasharray="4 3"
          />
          <Tooltip content={<TrendTooltip />} />
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
