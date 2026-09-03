import { Bar, BarChart, CartesianGrid, ResponsiveContainer, XAxis, YAxis } from 'recharts';
import {
  CHART_AXIS,
  CHART_GRID,
  CHART_MARGIN,
  ChartFrame,
  formatDate,
  formatNumber,
  seriesColor,
} from '../../../ui';
import type { ActivityPoint } from '../../../types/domain';
import type { RangeDays, Section } from './overview-data';
import { rangeLabel, windowActivity } from './overview-data';
import { useTranslation } from '../../../i18n/useTranslation';
import { t as translateNow } from '../../../i18n/i18n';

/**
 * A backend day string as a short axis tick.
 *
 * The backend groups by calendar day and sends `YYYY-MM-DD`. `new Date("2026-07-20")`
 * parses as UTC midnight, so formatting it in a viewer's local zone west of UTC
 * shifts the label back a day — the tick then disagrees with the day the
 * backend actually grouped by. The parts are read as a LOCAL date instead.
 */
function toLocalDate(date: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

const TICK = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });

function tickLabel(date: string): string {
  const parsed = toLocalDate(date);
  return parsed ? TICK.format(parsed) : date;
}

export interface ActivityChartProps {
  section: Section<ActivityPoint[]>;
  days: RangeDays;
}

/**
 * Daily message volume over the selected window.
 *
 * The series is fetched at twice the window so the previous period can be cut
 * from it, so the selected window is applied here — see `windowActivity`.
 */
export function ActivityChart({ section, days }: ActivityChartProps) {
  const { t } = useTranslation();
  const points = windowActivity(section.data, days);
  const total = points.reduce((sum, point) => sum + (point.messages ?? 0), 0);

  return (
    <ChartFrame
      height={220}
      loading={section.loading}
      error={section.error}
      onRetry={section.retry}
      empty={points.length === 0 || total === 0}
      emptyTitle="No messages in this period"
      emptyDescription="Once visitors start chatting, each day's volume appears here. Try a longer range."
      summary={
        translateNow('agents.messagesOverDays', {
          count: formatNumber(total),
          days: points.length,
          range: rangeLabel(days).toLowerCase(),
        }) || `${formatNumber(total)} messages over ${points.length} days, ${rangeLabel(days).toLowerCase()}.`
      }
      dataTable={
        <table className="w-full text-left text-xs">
          <caption className="sr-only">{t('agents.messagesPerDay') || 'Messages per day'}</caption>
          <thead>
            <tr className="text-text-tertiary">
              <th scope="col" className="py-1 pr-4 font-medium">
                {t('agents.day') || 'Day'}
              </th>
              <th scope="col" className="py-1 font-medium">
                {t('agents.messages') || 'Messages'}
              </th>
            </tr>
          </thead>
          <tbody>
            {points.map((point) => (
              <tr key={point.date} className="border-t border-border">
                <td className="py-1 pr-4 text-text-secondary">{formatDate(toLocalDate(point.date))}</td>
                <td className="figure py-1 text-text-primary">{formatNumber(point.messages ?? 0)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      }
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={points as ActivityPoint[]} margin={CHART_MARGIN}>
          <CartesianGrid {...CHART_GRID} />
          <XAxis dataKey="date" tickFormatter={tickLabel} minTickGap={24} {...CHART_AXIS} />
          <YAxis allowDecimals={false} width={32} {...CHART_AXIS} />
          <Bar dataKey="messages" fill={seriesColor(0)} radius={[2, 2, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </ChartFrame>
  );
}
