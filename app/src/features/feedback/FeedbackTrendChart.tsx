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
import { useChartPalette, type ChartPalette } from '../analytics/chart-theme';
import { type FeedbackTrendPoint } from './feedback-helpers';

type TrendTooltipProps = TooltipProps<number | string, number | string> & {
  palette: ChartPalette;
};

function TrendTooltip({ active, payload, label, palette }: TrendTooltipProps): ReactElement | null {
  if (!active || !payload || payload.length === 0) return null;
  const raw = payload[0]?.value;
  const rate = typeof raw === 'number' ? raw : Number(raw) || 0;
  return (
    <div
      className="rounded-lg border px-3 py-2 shadow-[var(--ds-shadow-md)]"
      style={{ background: palette.surface, borderColor: palette.border }}
    >
      <p className="text-[11px] font-medium" style={{ color: palette.muted }}>
        {label}
      </p>
      <p className="mt-0.5 text-sm font-bold tabular-nums" style={{ color: palette.text }}>
        {rate}%
        <span className="ml-1 text-[11px] font-normal" style={{ color: palette.muted }}>
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
 *
 * Colors come from `useChartPalette()` as concrete, theme-aware values — the
 * same hook the sibling `MessageTrendChart` uses — because Recharts renders
 * `stroke`/`fill`/tick/grid/cursor straight to SVG presentation attributes,
 * which do NOT resolve CSS `var(--…)` custom properties. The palette has no
 * dedicated success color, so the positive-rate line uses the lead accent,
 * matching `MessageTrendChart`.
 */
export function FeedbackTrendChart({ points }: FeedbackTrendChartProps): ReactElement {
  const palette = useChartPalette();
  const chartLabel = `Daily positive feedback rate across ${points.length} day${points.length === 1 ? '' : 's'}.`;

  return (
    <Card className="p-5">
      <SectionHeader title="Satisfaction trend" description="Daily positive-rate over time" />
      <div className="mt-4 h-40" role="img" aria-label={chartLabel}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={points} margin={{ top: 8, right: 12, bottom: 4, left: 4 }}>
            <XAxis
              dataKey="date"
              tick={{ fontSize: 10, fill: palette.axis }}
              axisLine={false}
              tickLine={false}
              padding={{ left: 12, right: 12 }}
            />
            <YAxis
              domain={[0, 100]}
              tick={{ fontSize: 10, fill: palette.axis }}
              axisLine={false}
              tickLine={false}
              tickFormatter={(value: number) => `${value}%`}
              width={40}
            />
            <Tooltip
              content={<TrendTooltip palette={palette} />}
              cursor={{ stroke: palette.accent, strokeOpacity: 0.25 }}
            />
            <Line
              type="monotone"
              dataKey="rate"
              stroke={palette.accent}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, fill: palette.accent }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}
