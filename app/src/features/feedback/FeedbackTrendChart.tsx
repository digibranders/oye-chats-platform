import { type ReactElement } from 'react';
import {
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipProps,
} from 'recharts';
import { Card, SectionHeader } from '../../design-system';
import { type FeedbackTrendPoint } from './feedback-helpers';

/** Chart colors sourced from design-system CSS custom properties (theme-aware). */
const CHART = {
  success: 'var(--ds-success)',
  grid: 'var(--ds-border)',
  axis: 'var(--ds-text-subtle)',
} as const;

function TrendTooltip({
  active,
  payload,
  label,
}: TooltipProps<number | string, number | string>): ReactElement | null {
  if (!active || !payload || payload.length === 0) return null;
  const raw = payload[0]?.value;
  const rate = typeof raw === 'number' ? raw : Number(raw) || 0;
  return (
    <div className="rounded-lg border border-[var(--ds-border)] bg-[var(--ds-bg-surface)] px-3 py-2 shadow-[var(--ds-shadow-md)]">
      <p className="text-[11px] font-medium text-[var(--ds-text-muted)]">{label}</p>
      <p className="mt-0.5 text-sm font-bold tabular-nums text-[var(--ds-text)]">
        {rate}%
        <span className="ml-1 text-[11px] font-normal text-[var(--ds-text-muted)]">
          positive rate
        </span>
      </p>
    </div>
  );
}

interface FeedbackTrendChartProps {
  points: FeedbackTrendPoint[];
}

/**
 * FeedbackTrendChart — daily positive-rate trend (last 14 buckets). Restyled
 * port of the legacy CSAT trend line (`pages/Feedback.jsx:222-239`). The
 * caller decides whether there's enough signal to render (matches the legacy
 * `trendData.length > 1` gate).
 */
export function FeedbackTrendChart({ points }: FeedbackTrendChartProps): ReactElement {
  const chartLabel = `Daily positive feedback rate across ${points.length} day${points.length === 1 ? '' : 's'}.`;

  return (
    <Card className="p-5">
      <SectionHeader title="Satisfaction trend" description="Daily positive-rate over time" />
      <div className="mt-4 h-40" role="img" aria-label={chartLabel}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
            <XAxis
              dataKey="date"
              tick={{ fontSize: 10, fill: CHART.axis }}
              axisLine={false}
              tickLine={false}
              padding={{ left: 12, right: 12 }}
            />
            <YAxis
              domain={[0, 100]}
              tick={{ fontSize: 10, fill: CHART.axis }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(value: number) => `${value}%`}
              width={40}
            />
            <Tooltip content={<TrendTooltip />} cursor={{ stroke: CHART.success, strokeOpacity: 0.25 }} />
            <Line
              type="monotone"
              dataKey="rate"
              stroke={CHART.success}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, fill: CHART.success }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}
