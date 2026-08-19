import {
  CartesianGrid,
  Line,
  LineChart,
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
  ChartLegend,
  formatCompact,
  formatNumber,
} from '../../ui';
import { seriesColor, seriesDash } from '../../ui';
import type { ComparisonPoint } from './series';

/**
 * Messages per day, against the same number of days before them.
 *
 * The chart it replaces was a single series marked `aria-hidden` with no
 * alternative beside it, so the one thing it existed to show — the shape of the
 * series — was unavailable to anyone not looking at it. `ChartFrame` requires
 * the summary and takes the table, and the comparison line is what makes the
 * picture answer the question the page is for.
 */

/** The comparison line is muted and dashed: it is context, not a second metric. */
const CURRENT_SERIES = 0;
const PREVIOUS_SERIES = 7;

function VolumeTooltip({ active, payload, label }: TooltipProps<number, string>) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div className="rounded-md border border-border bg-surface px-2.5 py-2 shadow-md">
      <p className="text-2xs text-text-tertiary">{label}</p>
      {payload.map((entry) => (
        <p key={String(entry.dataKey)} className="figure text-xs text-text-primary">
          {entry.name}: {formatNumber(typeof entry.value === 'number' ? entry.value : null)}
        </p>
      ))}
    </div>
  );
}

export interface MessageVolumeChartProps {
  points: readonly ComparisonPoint[];
  /** "Last 30 days". Used in the summary sentence. */
  rangeLabel: string;
  /** "the previous 30 days", or null when the range has nothing before it. */
  comparisonLabel: string | null;
  total: number;
  previousTotal: number | null;
  dailyAverage: number;
  peak: number;
  peakLabel: string | null;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}

function buildSummary(props: MessageVolumeChartProps): string {
  const { points, rangeLabel, comparisonLabel, total, previousTotal, dailyAverage, peak, peakLabel } =
    props;
  const span =
    points.length > 0 ? ` from ${points[0].label} to ${points[points.length - 1].label}` : '';
  const peakSentence =
    peak > 0 && peakLabel ? ` The busiest day was ${peakLabel}, with ${peak} messages.` : '';
  const comparison =
    comparisonLabel && previousTotal !== null
      ? ` The same measure over ${comparisonLabel} was ${previousTotal}.`
      : '';
  return `Messages sent per day over ${rangeLabel.toLowerCase()}${span}: ${total} in total, an average of ${dailyAverage} a day.${peakSentence}${comparison}`;
}

export function MessageVolumeChart(props: MessageVolumeChartProps) {
  const { points, comparisonLabel, loading = false, error = null, onRetry } = props;
  const hasComparison = points.some((point) => point.previous !== null);

  return (
    <div>
      <ChartFrame
        height={260}
        loading={loading}
        error={error}
        onRetry={onRetry}
        empty={points.length === 0 || props.total === 0}
        emptyTitle="No messages in this period"
        emptyDescription="Nobody sent the chatbot anything in this window. Try a wider period, or check that the widget is still on your site."
        summary={buildSummary(props)}
        dataTable={
          <table className="w-full text-left text-xs">
            <caption className="sr-only">Messages per day, with the previous period</caption>
            <thead>
              <tr className="text-text-tertiary">
                <th scope="col" className="py-1 pr-4 font-medium">
                  Day
                </th>
                <th scope="col" className="py-1 pr-4 font-medium">
                  Messages
                </th>
                {hasComparison ? (
                  <th scope="col" className="py-1 font-medium">
                    Previous period
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {points.map((point) => (
                <tr key={point.date} className="border-t border-border">
                  <th scope="row" className="py-1 pr-4 font-normal text-text-secondary">
                    {point.label}
                  </th>
                  <td className="figure py-1 pr-4 text-text-primary">
                    {formatNumber(point.messages)}
                  </td>
                  {hasComparison ? (
                    <td className="figure py-1 text-text-secondary">
                      {formatNumber(point.previous)}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        }
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={[...points]} margin={CHART_MARGIN}>
            <CartesianGrid {...CHART_GRID} />
            <XAxis dataKey="label" {...CHART_AXIS} minTickGap={24} />
            <YAxis
              {...CHART_AXIS}
              width={44}
              allowDecimals={false}
              tickFormatter={(value: number) => formatCompact(value)}
            />
            <Tooltip content={<VolumeTooltip />} />
            {hasComparison ? (
              <Line
                type="monotone"
                dataKey="previous"
                name={comparisonLabel ?? 'Previous period'}
                stroke={seriesColor(PREVIOUS_SERIES)}
                strokeDasharray={seriesDash(4)}
                strokeWidth={1.5}
                dot={false}
                connectNulls={false}
                isAnimationActive={false}
              />
            ) : null}
            <Line
              type="monotone"
              dataKey="messages"
              name="This period"
              stroke={seriesColor(CURRENT_SERIES)}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </ChartFrame>

      {points.length > 0 && props.total > 0 ? (
        <ChartLegend
          className="mt-3"
          items={
            hasComparison
              ? [
                  { label: 'This period', seriesIndex: CURRENT_SERIES },
                  { label: comparisonLabel ?? 'Previous period', seriesIndex: PREVIOUS_SERIES },
                ]
              : [{ label: 'This period', seriesIndex: CURRENT_SERIES }]
          }
        />
      ) : null}
    </div>
  );
}
