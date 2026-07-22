import { useMemo, useState, type ReactElement } from 'react';
import { Activity } from 'lucide-react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card, SectionHeader, Skeleton, cn } from '../../../design-system';
import { type EngagementPoint } from './analytics.types';
import { CHART, ChartTooltip } from './chartTheme';

type Range = '7d' | '30d' | '90d' | 'all';

const RANGES: readonly { id: Range; label: string; days: number | null }[] = [
  { id: '7d', label: '7 days', days: 7 },
  { id: '30d', label: '30 days', days: 30 },
  { id: '90d', label: '90 days', days: 90 },
  { id: 'all', label: 'All time', days: null },
];

interface EngagementChartProps {
  data: EngagementPoint[];
  loading: boolean;
}

/**
 * EngagementChart — daily message volume over a selectable window. The window
 * only slices the already-fetched series (client-side), so switching ranges is
 * instant and never refetches.
 */
export function EngagementChart({ data, loading }: EngagementChartProps): ReactElement {
  // Default to the full (already-capped) window so the headline "Messages" KPI
  // — which sums the whole series — reconciles with the chart's own total.
  const [range, setRange] = useState<Range>('all');

  const windowed = useMemo(() => {
    const days = RANGES.find((r) => r.id === range)?.days ?? null;
    return days === null ? data : data.slice(-days);
  }, [data, range]);

  const total = useMemo(() => windowed.reduce((sum, p) => sum + p.messages, 0), [windowed]);

  // Screen-reader equivalent for the SVG trend: the timeline is otherwise
  // conveyed only visually (WCAG 1.1.1). Summarise the window's total and peak.
  const chartLabel = useMemo(() => {
    const rangeLabel = (RANGES.find((r) => r.id === range)?.label ?? '').toLowerCase();
    const peak = windowed.reduce<EngagementPoint | null>(
      (best, point) => (best === null || point.messages > best.messages ? point : best),
      null,
    );
    const base = `Daily message volume over ${rangeLabel}: ${total.toLocaleString()} messages total`;
    return peak && peak.messages > 0
      ? `${base}, peaking at ${peak.messages.toLocaleString()} on ${peak.label}.`
      : `${base}.`;
  }, [windowed, range, total]);

  return (
    <Card className="p-5">
      <SectionHeader
        title="Message volume"
        description="How many messages your AI handled each day."
        actions={
          <div
            role="group"
            aria-label="Time range"
            className="flex items-center gap-1 rounded-lg bg-[var(--ds-bg-sunken)] p-1"
          >
            {RANGES.map((r) => (
              <button
                key={r.id}
                type="button"
                aria-pressed={range === r.id}
                onClick={() => setRange(r.id)}
                className={cn(
                  'rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]',
                  range === r.id
                    ? 'bg-[var(--ds-bg-surface)] text-[var(--ds-text)] shadow-[var(--ds-shadow-sm)]'
                    : 'text-[var(--ds-text-muted)] hover:text-[var(--ds-text)]',
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
        }
      />

      <div className="mt-5 h-72">
        {loading ? (
          <Skeleton className="h-full w-full rounded-xl" />
        ) : total === 0 ? (
          <div className="flex h-full flex-col items-center justify-center rounded-xl border border-dashed border-[var(--ds-border)] text-center">
            <Activity className="mb-2 text-[var(--ds-text-subtle)]" size={26} aria-hidden="true" />
            <p className="text-[13px] text-[var(--ds-text-muted)]">
              No messages in this range yet.
            </p>
          </div>
        ) : (
          <div role="img" aria-label={chartLabel} className="h-full w-full">
            <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={windowed} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
              <defs>
                <linearGradient id="agent-engagement-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={CHART.accent} stopOpacity={0.28} />
                  <stop offset="100%" stopColor={CHART.accent} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={CHART.grid} />
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={false}
                tick={{ fill: CHART.axis, fontSize: 11 }}
                dy={8}
                minTickGap={24}
              />
              <YAxis
                allowDecimals={false}
                tickLine={false}
                axisLine={false}
                tick={{ fill: CHART.axis, fontSize: 11 }}
                width={44}
              />
              <Tooltip
                content={<ChartTooltip unit="messages" />}
                cursor={{ stroke: CHART.accent, strokeOpacity: 0.25 }}
              />
              <Area
                type="monotone"
                dataKey="messages"
                stroke={CHART.accent}
                strokeWidth={2}
                fill="url(#agent-engagement-fill)"
              />
            </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </Card>
  );
}
