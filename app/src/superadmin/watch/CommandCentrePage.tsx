import { useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ChartFrame,
  CodeBlock,
  DataTable,
  EmptyState,
  Grid,
  LoadingRows,
  PropertyGrid,
  SegmentedControl,
  StatRow,
  Stack,
  Section,
  formatCompact,
  formatDuration,
  formatNumber,
  seriesColor,
  type Column,
} from '../../ui';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip as RechartsTooltip, XAxis, YAxis } from 'recharts';
import { CHART_AXIS, CHART_GRID, CHART_MARGIN } from '../../ui/charts/theme';
import { PlatformPage } from '../PlatformPage';
import { usePlatformList, usePlatformResource, useUrlState } from '../usePlatform';
import { USD_NORMALISED_SHORT, usdCentsRounded } from '../money';
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
/** The queue table's columns. Numerics right-aligned, state carried by a word. */
const queueColumns: readonly Column<QueueStatus>[] = [
  {
    key: 'queue_name',
    header: 'Queue',
    rowHeader: true,
    type: 'id',
    render: (row) => row.queue_name,
  },
  { key: 'pending', header: 'Waiting', type: 'number', render: (row) => formatNumber(row.pending) },
  {
    key: 'in_flight',
    header: 'Running',
    type: 'number',
    render: (row) => formatNumber(row.in_flight),
  },
  { key: 'failed', header: 'Retrying', type: 'number', render: (row) => formatNumber(row.failed) },
  {
    key: 'oldest',
    header: 'Oldest wait',
    align: 'right',
    render: (row) =>
      row.oldest_pending_seconds > 300 ? (
        <Badge tone="danger" dot>
          {formatDuration(row.oldest_pending_seconds)}
        </Badge>
      ) : row.oldest_pending_seconds > 0 ? (
        <span className="figure">{formatDuration(row.oldest_pending_seconds)}</span>
      ) : (
        <span className="text-text-tertiary">Nothing waiting</span>
      ),
  },
  {
    key: 'workers',
    header: 'Workers',
    align: 'right',
    render: (row) =>
      row.workers_alive === 0 ? (
        <Badge tone="danger" dot>
          None alive
        </Badge>
      ) : (
        <span className="figure">{formatNumber(row.workers_alive)}</span>
      ),
  },
];

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
        <>
          {/* The timestamp that qualifies every number on the page, beside the
              control that changes it — it used to sit below the fold, four
              screenfuls from the figures it dates. */}
          <span className="figure text-xs text-text-tertiary">
            Read {new Date(refreshedAt).toLocaleTimeString()}
          </span>
          <Button size="sm" variant="secondary" onClick={refresh}>
            <RefreshCw aria-hidden />
            Refresh
          </Button>
        </>
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

        {/* One band, three peers: is anything broken, is anything backing up,
            and how the month is going. They used to be three full-width cards
            stacked down four screenfuls of an ops console's front page. */}
        <Grid cols={3} align="start">
          <Card>
            <CardHeader size="sm" titleAs="h2" title="Services" />
            {health.loading && !health.data ? (
              <CardBody>
                <LoadingRows rows={5} />
              </CardBody>
            ) : health.data ? (
              <CardBody>
                <PropertyGrid
                  label="Service health"
                  density="compact"
                  items={[
                    ...HEALTH_SERVICES.map((service) => ({
                      label: service.label,
                      value: (
                        <Badge tone={serviceTone(health.data![service.key])} dot>
                          {serviceLabel(health.data![service.key])}
                        </Badge>
                      ),
                    })),
                    {
                      label: 'API version',
                      value: <span className="figure">{health.data.version}</span>,
                    },
                  ]}
                />
              </CardBody>
            ) : null}
          </Card>

          <Card>
            <CardHeader size="sm" titleAs="h2" title="Queues" />
            <CardBody flush>
              {/* A table, not five tiles per queue in a five-column grid: with
                  two queues that was ten tiles whose only tie to their row was
                  the first tile's value being the queue's name, set as a
                  22px tabular figure. */}
              <DataTable
                seated
                caption="ARQ queues, read from Redis"
                columns={queueColumns}
                rows={queues.items}
                rowKey={(row) => row.queue_name}
                rowNoun="queue"
                loading={queues.loading && queues.items.length === 0}
                empty={
                  <EmptyState
                    size="inline"
                    title="No queue reported"
                    description="Redis did not answer — the services panel says whether it is reachable."
                  />
                }
              />
            </CardBody>
          </Card>

          <Card>
            <CardHeader size="sm" titleAs="h2" title="The month" />
            <CardBody flush>
              <StatRow
                columns={2}
                label="This month"
                period="This month"
                loading={centre.loading || stats.loading}
                items={[
                  {
                    label: 'Revenue this month',
                    size: 'lg',
                    value: centre.data
                      ? usdCentsRounded(centre.data.revenue_current_month_cents)
                      : undefined,
                    period: centre.data
                      ? `${usdCentsRounded(centre.data.revenue_last_month_cents)} last month`
                      : USD_NORMALISED_SHORT,
                    delta:
                      centre.data?.growth_pct != null
                        ? {
                            value: `${Math.abs(centre.data.growth_pct)}%`,
                            direction:
                              centre.data.growth_pct > 0
                                ? 'up'
                                : centre.data.growth_pct < 0
                                  ? 'down'
                                  : 'flat',
                            label: 'on last year',
                          }
                        : undefined,
                  },
                  {
                    label: 'Revenue this year',
                    size: 'lg',
                    value: centre.data
                      ? usdCentsRounded(centre.data.growth_current_year_cents)
                      : undefined,
                    period: USD_NORMALISED_SHORT,
                  },
                  {
                    label: 'Signups this month',
                    value: centre.data
                      ? formatNumber(centre.data.signups_current_month)
                      : undefined,
                    period: centre.data
                      ? `${formatNumber(centre.data.signups_last_month)} last month`
                      : 'This month',
                  },
                  {
                    label: 'Accounts',
                    value: stats.data ? formatNumber(stats.data.total_clients) : undefined,
                    period: 'All time',
                  },
                  {
                    label: 'Conversations',
                    value: centre.data ? formatCompact(centre.data.chats_total) : undefined,
                    period: 'All time',
                  },
                  {
                    label: 'Handed to a person',
                    value: centre.data ? formatCompact(centre.data.operator_transfers) : undefined,
                    period: 'All time',
                  },
                  {
                    label: 'Qualified leads',
                    value: centre.data
                      ? formatCompact(centre.data.bant_qualified_leads)
                      : undefined,
                    period: 'All time',
                  },
                  {
                    label: 'Meetings booked',
                    value: centre.data ? formatNumber(centre.data.booked_meetings) : undefined,
                    period: 'All time',
                  },
                ]}
              />
            </CardBody>
          </Card>
        </Grid>

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
                description="The Sentry DSN is write-only, so this endpoint returns an empty list by design. Read errors in Sentry itself."
              />
            ) : (
              <CardBody>
                <CodeBlock label="errors.json" code={JSON.stringify(errors.items, null, 2)} />
              </CardBody>
            )}
          </Card>
        </Section>
      </Stack>
    </PlatformPage>
  );
}
