import { useMemo } from 'react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  CHART_AXIS,
  CHART_GRID,
  CHART_MARGIN,
  ChartFrame,
  formatCompact,
  formatDate,
  formatNumber,
  seriesColor,
} from '../../../ui';
import type { TrendPoint } from '../usage-model';

interface Row {
  date: string;
  label: string;
  credits: number;
}

function TrendTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: Row }> }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  return (
    <div className="rounded-sm border border-border bg-surface px-2 py-1.5 shadow-md">
      <p className="text-xs text-text-secondary">{formatDate(row.date)}</p>
      <p className="figure text-sm font-medium text-text-primary">
        {formatNumber(row.credits)} credits
      </p>
    </div>
  );
}

/**
 * Credits consumed per day across the selected window.
 *
 * Consumption only: plan grants, top-ups, refunds and expiries are movements in
 * the ledger but they are not spend, and folding them in would make a month in
 * which the customer bought credits look like a month in which they burned
 * them. The backend draws the same line in `_CONSUMPTION_REASONS`.
 */
export function ConsumptionTrend({
  points,
  days,
  scopeLabel,
  loading,
  error,
  onRetry,
}: {
  points: TrendPoint[];
  days: number;
  scopeLabel: string;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const rows = useMemo<Row[]>(
    () =>
      points.map((point) => ({
        date: point.date,
        label: formatDate(point.date).replace(/ \d{4}$/, ''),
        credits: point.creditsUsed,
      })),
    [points],
  );

  const total = rows.reduce((sum, row) => sum + row.credits, 0);
  const peak = rows.reduce<Row | null>((best, row) => (!best || row.credits > best.credits ? row : best), null);

  return (
    <ChartFrame
      loading={loading}
      error={error}
      onRetry={onRetry}
      empty={!loading && !error && total === 0}
      emptyTitle={`No credits spent in the last ${days} days`}
      emptyDescription={`Nothing in ${scopeLabel} has consumed a credit in this window. Spend appears here the day it happens.`}
      height={220}
      summary={
        total === 0
          ? `No credits were spent in ${scopeLabel} over the last ${days} days.`
          : `${scopeLabel} spent ${formatNumber(total)} credits over the last ${days} days, averaging ${formatNumber(Math.round(total / Math.max(rows.length, 1)))} a day${peak ? `, with a peak of ${formatNumber(peak.credits)} on ${formatDate(peak.date)}` : ''}.`
      }
      dataTable={
        <table className="w-full text-xs">
          <caption className="sr-only">
            Credits consumed per day in {scopeLabel} over the last {days} days
          </caption>
          <thead>
            <tr className="text-text-tertiary">
              <th scope="col" className="py-1 pr-4 text-left font-medium">
                Day
              </th>
              <th scope="col" className="py-1 text-right font-medium">
                Credits used
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.date} className="border-t border-border">
                <th scope="row" className="py-1 pr-4 text-left font-normal text-text-secondary">
                  {formatDate(row.date)}
                </th>
                <td className="figure py-1 text-right text-text-primary">
                  {formatNumber(row.credits)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      }
    >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={rows} margin={CHART_MARGIN}>
          <CartesianGrid {...CHART_GRID} />
          <XAxis dataKey="label" {...CHART_AXIS} minTickGap={28} />
          <YAxis
            {...CHART_AXIS}
            width={44}
            allowDecimals={false}
            tickFormatter={(value: number) => formatCompact(value)}
          />
          <Tooltip content={<TrendTooltip />} />
          <Area
            type="monotone"
            dataKey="credits"
            name="Credits used"
            stroke={seriesColor(0)}
            fill={seriesColor(0)}
            fillOpacity={0.12}
            strokeWidth={2}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
