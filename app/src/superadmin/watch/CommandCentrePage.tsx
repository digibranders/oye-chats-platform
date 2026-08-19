import { useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  ChartFrame,
  EmptyState,
  SegmentedControl,
  Skeleton,
  StatTile,
  Stack,
  Section,
  cn,
  formatCompact,
  formatDuration,
  formatNumber,
  seriesColor,
} from '../../ui';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip as RechartsTooltip, XAxis, YAxis } from 'recharts';
import { CHART_AXIS, CHART_GRID, CHART_MARGIN } from '../../ui/charts/theme';
import { PlatformPage } from '../PlatformPage';
import { usePlatformList, usePlatformResource, useUrlState } from '../usePlatform';
import {
  HEALTH_SERVICES,
  serviceLabel,
  serviceTone,
  type CommandCentre,
  type PlatformStats,
  type QueueStatus,
  type SystemHealth,
  type TimeseriesMetric,
  type TimeseriesPoint,
} from './types';

const METRICS: { value: TimeseriesMetric; label: string }[] = [
  { value: 'revenue', label: 'Revenue' },
  { value: 'messages', label: 'Messages' },
  { value: 'signups', label: 'Signups' },
];

const RANGES = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
];

/** USD cents to a readable amount. The endpoint normalises INR invoices for us. */
function usd(cents: number | undefined): string {
  if (cents === undefined) return '—';
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

/**
 * The platform, right now.
 *
 * The first screen of a console that did not exist: about a hundred
 * `/superadmin/*` endpoints shipped with no client function of any kind, so
 * every question an operator might have — is the worker alive, did revenue move,
 * how many accounts signed up this month — was answerable only by SSH.
 *
 * What is on it is chosen by the question it answers, in order: is anything
 * broken, is anything backing up, and then how the month is going. Money is
 * third, because a queue that has stopped draining costs more than a slow
 * month does.
 */
export function CommandCentrePage() {
  const url = useUrlState();
  const metric = (url.get('metric', 'revenue') as TimeseriesMetric) ?? 'revenue';
  const days = url.get('days', '30');

  const health = usePlatformResource<SystemHealth>('/system/health/full');
  const centre = usePlatformResource<CommandCentre>('/command-center');
  const stats = usePlatformResource<PlatformStats>('/stats');
  const queues = usePlatformList<QueueStatus>('/workers/status');
  const errors = usePlatformList<Record<string, unknown>>('/errors');
  const series = usePlatformList<TimeseriesPoint>('/stats/timeseries', {
    params: { metric, days },
  });

  // Stamped so the footer can say when these numbers were read. A console
  // showing live infrastructure state with no read time invites someone to act
  // on a figure that is twenty minutes old.
  const [refreshedAt, setRefreshedAt] = useState<number>(() => Date.now());

  const chartData = useMemo(
    () =>
      series.items.map((point) => ({
        date: point.date,
        value: metric === 'revenue' ? point.value / 100 : point.value,
      })),
    [series.items, metric],
  );

  // A chart is a picture; the summary is how it reads to anyone not looking at
  // it, and to anyone printing the page.
  const chartSummary = useMemo(() => {
    if (chartData.length === 0) return `No ${metric} recorded in the last ${days} days.`;
    const values = chartData.map((point) => point.value);
    const total = values.reduce((sum, value) => sum + value, 0);
    const peak = Math.max(...values);
    const unit = metric === 'revenue' ? 'US dollars' : metric;
    return `${METRICS.find((entry) => entry.value === metric)?.label ?? 'Revenue'} over the last ${days} days, daily: ${formatNumber(Math.round(total))} ${unit} in total, peaking at ${formatNumber(Math.round(peak))} on ${chartData.reduce((best, point) => (point.value > best.value ? point : best), chartData[0]).date}.`;
  }, [chartData, metric, days]);

  const degraded = health.data && health.data.status !== 'healthy';
  const backedUp = queues.items.some((queue) => queue.workers_alive === 0 || queue.oldest_pending_seconds > 300);

  function refresh(): void {
    health.reload();
    centre.reload();
    stats.reload();
    queues.reload();
    errors.reload();
    series.reload();
    setRefreshedAt(Date.now());
  }

  return (
    <PlatformPage
      title="Command centre"
      description="Everything that would otherwise need a shell on the box."
      forbidden={health.forbidden}
      error={health.error && !health.data ? health.error : null}
      onRetry={refresh}
      actions={
        <Button size="sm" variant="secondary" onClick={refresh}>
          <RefreshCw aria-hidden className="h-3.5 w-3.5" />
          Refresh
        </Button>
      }
    >
      <Stack>
        {degraded ? (
          <Alert tone="danger" live title="The platform is degraded">
            At least one service the API depends on is unreachable. The services below say which.
          </Alert>
        ) : null}
        {backedUp ? (
          <Alert tone="warning" title="Work is not draining">
            A queue has no live worker, or its oldest job has been waiting more than five minutes.
            Ingestion, invoice PDFs and qualification all run through it.
          </Alert>
        ) : null}

        <Section title="Services" description="Read live from the API process, not from a status page.">
          <Card>
            {health.loading && !health.data ? (
              <CardBody className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                {HEALTH_SERVICES.map((service) => (
                  <Skeleton key={service.key} className="h-12" />
                ))}
              </CardBody>
            ) : health.data ? (
              <>
                <CardBody className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                  {HEALTH_SERVICES.map((service) => {
                    const state = health.data![service.key];
                    return (
                      <div
                        key={service.key}
                        className="rounded-md border border-border bg-surface-sunken px-3 py-2.5"
                      >
                        <p className="text-xs text-text-tertiary">{service.label}</p>
                        <Badge tone={serviceTone(state)} dot className="mt-1.5">
                          {serviceLabel(state)}
                        </Badge>
                      </div>
                    );
                  })}
                </CardBody>
                <div className="border-t border-border px-5 py-2.5">
                  <p className="text-2xs text-text-tertiary">
                    API version <span className="figure">{health.data.version}</span>
                  </p>
                </div>
              </>
            ) : null}
          </Card>
        </Section>

        <Section title="Queues" description="ARQ, read from Redis. Every count is best-effort and degrades to zero.">
          <Card>
            {queues.loading && queues.items.length === 0 ? (
              <CardBody>
                <Skeleton className="h-16" />
              </CardBody>
            ) : queues.items.length === 0 ? (
              <EmptyState
                compact
                title="No queue reported"
                description="Redis did not answer, so there is nothing to show. That is itself worth looking at — the services panel above says whether Redis is reachable."
              />
            ) : (
              <CardBody className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
                {queues.items.map((queue) => (
                  <div key={queue.queue_name} className="contents">
                    <StatTile label="Queue" value={queue.queue_name} period="Right now" />
                    <StatTile
                      label="Waiting"
                      value={formatNumber(queue.pending)}
                      period="Right now"
                      tone={queue.pending > 100 ? 'warning' : 'neutral'}
                    />
                    <StatTile label="Running" value={formatNumber(queue.in_flight)} period="Right now" />
                    <StatTile
                      label="Retrying"
                      value={formatNumber(queue.failed)}
                      period="Right now"
                      tone={queue.failed > 0 ? 'warning' : 'neutral'}
                    />
                    <StatTile
                      label="Oldest wait"
                      value={
                        queue.oldest_pending_seconds > 0
                          ? formatDuration(queue.oldest_pending_seconds)
                          : 'Nothing waiting'
                      }
                      period="Right now"
                      tone={queue.oldest_pending_seconds > 300 ? 'danger' : 'neutral'}
                    />
                  </div>
                ))}
              </CardBody>
            )}
          </Card>
        </Section>

        <Section title="The month">
          <Card>
            <CardBody className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatTile
                label="Revenue this month"
                value={centre.data ? usd(centre.data.revenue_current_month_cents) : undefined}
                period={centre.data ? `${usd(centre.data.revenue_last_month_cents)} last month` : 'This month'}
                loading={centre.loading}
              />
              <StatTile
                label="Revenue this year"
                value={centre.data ? usd(centre.data.growth_current_year_cents) : undefined}
                period={
                  centre.data?.growth_pct != null
                    ? `${centre.data.growth_pct > 0 ? '+' : ''}${centre.data.growth_pct}% on last year`
                    : 'No comparable year'
                }
                loading={centre.loading}
              />
              <StatTile
                label="Signups this month"
                value={centre.data ? formatNumber(centre.data.signups_current_month) : undefined}
                period={centre.data ? `${formatNumber(centre.data.signups_last_month)} last month` : 'This month'}
                loading={centre.loading}
              />
              <StatTile
                label="Accounts"
                value={stats.data ? formatNumber(stats.data.total_clients) : undefined}
                period="All time"
                loading={stats.loading}
              />
            </CardBody>
            <CardBody className="grid gap-4 border-t border-border sm:grid-cols-2 lg:grid-cols-4">
              <StatTile
                label="Conversations"
                value={centre.data ? formatCompact(centre.data.chats_total) : undefined}
                period="All time"
                loading={centre.loading}
              />
              <StatTile
                label="Handed to a person"
                value={centre.data ? formatCompact(centre.data.operator_transfers) : undefined}
                period="All time"
                loading={centre.loading}
              />
              <StatTile
                label="Qualified leads"
                value={centre.data ? formatCompact(centre.data.bant_qualified_leads) : undefined}
                period="All time"
                loading={centre.loading}
              />
              <StatTile
                label="Meetings booked"
                value={centre.data ? formatNumber(centre.data.booked_meetings) : undefined}
                period="All time"
                loading={centre.loading}
              />
            </CardBody>
          </Card>
        </Section>

        <Section
          title="Over time"
          actions={
            <div className="flex flex-wrap items-center gap-2">
              <SegmentedControl
                size="sm"
                label="Metric"
                value={metric}
                onChange={(next) => url.set({ metric: next })}
                items={METRICS}
              />
              <SegmentedControl
                size="sm"
                label="Range"
                value={days}
                onChange={(next) => url.set({ days: next })}
                items={RANGES}
              />
            </div>
          }
        >
          <ChartFrame
            summary={chartSummary}
            loading={series.loading}
            error={series.error}
            onRetry={series.reload}
            empty={chartData.length === 0}
            height={260}
          >
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={CHART_MARGIN}>
                <CartesianGrid {...CHART_GRID} />
                <XAxis dataKey="date" {...CHART_AXIS} />
                <YAxis {...CHART_AXIS} width={48} />
                <RechartsTooltip />
                <Area
                  type="monotone"
                  dataKey="value"
                  stroke={seriesColor(0)}
                  fill={seriesColor(0)}
                  fillOpacity={0.12}
                  strokeWidth={2}
                />
              </AreaChart>
            </ResponsiveContainer>
          </ChartFrame>
        </Section>

        <Section title="Errors">
          <Card>
            {errors.items.length === 0 ? (
              <EmptyState
                compact
                title="No errors are readable from here"
                description="The platform configures a Sentry DSN, which is write-only — issues cannot be queried back without a Sentry API token, so this endpoint returns an empty list by design. Read errors in Sentry itself until that token is configured."
              />
            ) : (
              <CardBody>
                <pre className={cn('overflow-x-auto text-xs text-text-secondary')}>
                  {JSON.stringify(errors.items, null, 2)}
                </pre>
              </CardBody>
            )}
          </Card>
        </Section>
        <p className="figure pb-2 text-2xs text-text-tertiary">
          Read at {new Date(refreshedAt).toLocaleTimeString()}
        </p>
      </Stack>
    </PlatformPage>
  );
}
