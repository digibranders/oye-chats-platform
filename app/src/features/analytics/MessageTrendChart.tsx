import { type ReactElement } from 'react';
import { formatNumber } from '../../i18n/formatters';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipProps,
} from 'recharts';
import { type TrendPoint } from './analytics-types';
import { useChartPalette, type ChartPalette } from './chart-theme';

interface MessageTrendChartProps {
  points: TrendPoint[];
  /** Chart height in pixels. Defaults to 300. */
  height?: number;
}

type TrendTooltipProps = TooltipProps<number | string, number | string> & {
  palette: ChartPalette;
};

function TrendTooltip({ active, payload, label, palette }: TrendTooltipProps): ReactElement | null {
  if (!active || !payload || payload.length === 0) return null;
  const raw = payload[0]?.value;
  const value = typeof raw === 'number' ? raw : Number(raw) || 0;
  return (
    <div
      className="rounded-lg border px-3 py-2 shadow-[var(--ds-shadow-md)]"
      style={{ background: palette.surface, borderColor: palette.border }}
    >
      <p className="text-[11px] font-medium" style={{ color: palette.muted }}>
        {label}
      </p>
      <p className="mt-0.5 text-sm font-bold tabular-nums" style={{ color: palette.text }}>
        {formatNumber(value)}
        <span className="ml-1 text-[11px] font-normal" style={{ color: palette.muted }}>
          {value === 1 ? 'message' : 'messages'}
        </span>
      </p>
    </div>
  );
}

/**
 * MessageTrendChart - the workspace message-volume trend as a filled area
 * chart. Theme-aware (colors follow the DS theme) and horizontally responsive.
 * Decorative for screen readers; the accompanying summary metrics carry the
 * numbers in text.
 */
export function MessageTrendChart({ points, height = 300 }: MessageTrendChartProps): ReactElement {
  const palette = useChartPalette();

  return (
    <div aria-hidden="true">
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={points} margin={{ top: 12, right: 8, left: -16, bottom: 0 }}>
          <defs>
            <linearGradient id="analytics-trend-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={palette.accent} stopOpacity={0.35} />
              <stop offset="100%" stopColor={palette.accent} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={palette.grid} />
          <XAxis
            dataKey="label"
            tickLine={false}
            axisLine={false}
            tick={{ fill: palette.axis, fontSize: 11 }}
            dy={8}
            minTickGap={24}
          />
          <YAxis
            allowDecimals={false}
            tickLine={false}
            axisLine={false}
            tick={{ fill: palette.axis, fontSize: 11 }}
            width={40}
          />
          <Tooltip
            cursor={{ stroke: palette.accent, strokeOpacity: 0.25 }}
            content={<TrendTooltip palette={palette} />}
          />
          <Area
            type="monotone"
            dataKey="messages"
            stroke={palette.accent}
            strokeWidth={2}
            fill="url(#analytics-trend-fill)"
            dot={false}
            activeDot={{ r: 4, fill: palette.accent }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
