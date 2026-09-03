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
  CHART_CURSOR,
  CHART_GRID,
  CHART_MARGIN,
  ChartDataTable,
  ChartFrame,
  ChartLegend,
  ChartTooltip,
  formatCompact,
  formatNumber,
} from '../../ui';
import { seriesColor, seriesDash } from '../../ui';
import type { ComparisonPoint } from './series';
import { useTranslation } from '../../i18n/useTranslation';
import { t as translateNow } from '../../i18n/i18n';

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
    <ChartTooltip
      label={label}
      rows={payload.map((entry) => ({
        name: String(entry.name ?? entry.dataKey),
        value: formatNumber(typeof entry.value === 'number' ? entry.value : null),
        seriesIndex: entry.dataKey === 'previous' ? PREVIOUS_SERIES : CURRENT_SERIES,
      }))}
    />
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
    points.length > 0
      ? translateNow('analytics.volumeSpan', {
          from: points[0].label,
          to: points[points.length - 1].label,
        }) || ` from ${points[0].label} to ${points[points.length - 1].label}`
      : '';
  const peakSentence =
    peak > 0 && peakLabel
      ? translateNow('analytics.volumePeak', { day: peakLabel, count: peak }) ||
        ` The busiest day was ${peakLabel}, with ${peak} messages.`
      : '';
  const comparison =
    comparisonLabel && previousTotal !== null
      ? translateNow('analytics.volumeComparison', {
          period: comparisonLabel,
          count: previousTotal,
        }) || ` The same measure over ${comparisonLabel} was ${previousTotal}.`
      : '';
  const head =
    translateNow('analytics.volumeSummary', {
      range: rangeLabel.toLowerCase(),
      span,
      total,
      average: dailyAverage,
    }) ||
    `Messages sent per day over ${rangeLabel.toLowerCase()}${span}: ${total} in total, an average of ${dailyAverage} a day.`;
  return `${head}${peakSentence}${comparison}`;
}

export function MessageVolumeChart(props: MessageVolumeChartProps) {
  const { t } = useTranslation();
  const { points, comparisonLabel, loading = false, error = null, onRetry } = props;
  const hasComparison = points.some((point) => point.previous !== null);
  // A `LineChart` with one datum and `dot={false}` draws nothing at all, so a
  // single-day window used to paint a 260px box of gridlines under a heading
  // promising a trend. Two points is the floor for a line — the sibling
  // feedback chart already says so, and the two disagreed.
  const plottable = points.length >= 2 && props.total > 0;

  return (
    <ChartFrame
      height={260}
      loading={loading}
      error={error}
      onRetry={onRetry}
      empty={!plottable}
      emptyTitle={
        points.length === 1 ? t('analytics.notEnoughDaysToPlot') || 'Not enough days to plot' : t('analytics.noMessagesInThisPeriod') || 'No messages in this period'
      }
      emptyDescription={
        points.length === 1
          ? t('analytics.aLineNeedsMoreThan') || 'A line needs more than one day. The figures above already state this day’s total.'
          : t('analytics.nobodySentTheChatbotAnything') || 'Nobody sent the chatbot anything in this window. Try a wider period, or check that the widget is still on your site.'
      }
      summary={buildSummary(props)}
      legend={
        <ChartLegend
          items={
            hasComparison
              ? [
                  { label: t('analytics.thisPeriod') || 'This period', seriesIndex: CURRENT_SERIES },
                  { label: comparisonLabel ?? (t('analytics.previousPeriod') || 'Previous period'), seriesIndex: PREVIOUS_SERIES },
                ]
              : [{ label: t('analytics.thisPeriod') || 'This period', seriesIndex: CURRENT_SERIES }]
          }
        />
      }
      dataTable={
        <ChartDataTable
          caption={t('analytics.messagesPerDayWithThe') || 'Messages per day, with the previous period'}
          columns={[
            { key: 'day', header: t('analytics.day') || 'Day' },
            { key: 'messages', header: t('analytics.messages') || 'Messages', numeric: true },
            ...(hasComparison
              ? [{ key: 'previous', header: t('analytics.previousPeriod') || 'Previous period', numeric: true }]
              : []),
          ]}
          rowKey={(_row, index) => points[index].date}
          rows={points.map((point) => ({
            day: point.label,
            messages: formatNumber(point.messages),
            previous: formatNumber(point.previous),
          }))}
        />
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
          <Tooltip content={<VolumeTooltip />} cursor={CHART_CURSOR} />
          {hasComparison ? (
            <Line
              type="monotone"
              dataKey="previous"
              name={comparisonLabel ?? (t('analytics.previousPeriod') || 'Previous period')}
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
            dot={points.length < 3}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
