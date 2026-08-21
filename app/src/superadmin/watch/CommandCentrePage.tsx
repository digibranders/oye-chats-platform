import { useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  ChartFrame,
  DataTable,
  EmptyState,
  LoadingRows,
  SegmentedControl,
  StatRow,
  Stack,
  Section,
  formatCompact,
  formatDateTime,
  formatDuration,
  formatNumber,
  seriesColor,
  type Column,
} from '../../ui';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip as RechartsTooltip, XAxis, YAxis } from 'recharts';
import { CHART_AXIS, CHART_CURSOR, CHART_GRID, CHART_MARGIN } from '../../ui/charts/theme';
import { SeriesTooltip } from '../SeriesTooltip';
import { dayTick, tickInterval } from '../chartTicks';
import {
  errorCellText,
  errorFieldKeys,
  errorFieldLabel,
  errorLevelTone,
  isIsoInstant,
} from './errorTable';
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

  // The error list has no schema — see `errorTable`. Its columns are whatever
  // keys the payload actually carries, so nothing is invented and nothing the
  // server sent is dropped.
  const errorColumns = useMemo<readonly Column<Record<string, unknown>>[]>(
    () =>
      errorFieldKeys(errors.items).map((key) => ({
        key,
        header: errorFieldLabel(key),
        rowHeader: key === 'title' || key === 'message',
        align: typeof errors.items[0]?.[key] === 'number' ? ('right' as const) : undefined,
        render: (row: Record<string, unknown>) => {
          const value = row[key];
          if (key === 'level') {
            const text = errorCellText(value);
            return text ? (
              <Badge tone={errorLevelTone(value)} dot>
                {text}
              </Badge>
            ) : null;
          }
          if (isIsoInstant(value)) return formatDateTime(value);
          const text = errorCellText(value);
          return typeof value === 'number' ? <span className="figure">{text}</span> : text;
        },
      })),
    [errors.items],
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
  const faulty = health.data
    ? HEALTH_SERVICES.filter((service) => health.data![service.key] === 'unreachable').map(
        (service) => service.label,
      )
    : [];
  const backedUp = queues.items.some(
    (queue) => queue.workers_alive === 0 || queue.oldest_pending_seconds > 300,
  );
  const stalled = queues.items
    .filter((queue) => queue.workers_alive === 0 || queue.oldest_pending_seconds > 300)
    .map((queue) =>
      queue.workers_alive === 0
        ? `${queue.queue_name} has no live worker`
        : `${queue.queue_name} has waited ${formatDuration(queue.oldest_pending_seconds)}`,
    );

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
        {/* Each alert names the thing that is wrong. They used to describe the
            *class* of fault in a sentence — "at least one service is
            unreachable", "a queue has no live worker" — and then send the reader
            to a panel to find out which, which is two reads for one fact. */}
        {degraded ? (
          <Alert tone="danger" live title="The platform is degraded">
            {faulty.length > 0 ? `Unreachable: ${faulty.join(', ')}.` : 'A service the API depends on is not answering.'}
          </Alert>
        ) : null}
        {backedUp ? (
          <Alert tone="warning" title="Work is not draining">
            {stalled.length > 0
              ? `${stalled.join(', ')} — ingestion, invoice PDFs and qualification all run through these.`
              : 'A queue has no live worker, or its oldest job has been waiting more than five minutes.'}
          </Alert>
        ) : null}

        {/* Three bands, in the order the questions are asked: is anything
            broken, is anything backing up, and how the month is going.

            It was one `Grid cols={3}` row of three cards, which put every panel
            in a 323px column. At that width `PropertyGrid` correctly falls back
            to stacked, so six service facts cost 322px instead of ~200; the
            queue table lost its last two columns off the card's right edge; and
            the two short cards ended 154px and 213px above the tall one, so the
            band carried a hole the width of two thirds of the page. Each panel
            now gets the width its content actually needs. */}
        <Card>
          {/* No header: every chip names itself, and a 44px header band over one
              44px row of chips is more chrome than content. */}
          <CardBody className="flex flex-wrap items-center gap-x-6 gap-y-2">
            {health.loading && !health.data ? (
              <LoadingRows rows={1} />
            ) : health.data ? (
              <>
                {HEALTH_SERVICES.map((service) => (
                  <span key={service.key} className="flex items-center gap-2">
                    <span className="text-xs text-text-secondary">{service.label}</span>
                    <Badge tone={serviceTone(health.data![service.key])} dot>
                      {serviceLabel(health.data![service.key])}
                    </Badge>
                  </span>
                ))}
                <span className="flex items-center gap-2">
                  <span className="text-xs text-text-secondary">API version</span>
                  <span className="figure text-sm">{health.data.version}</span>
                </span>
              </>
            ) : null}
          </CardBody>
        </Card>

        <Section title="Queues">
          <Card>
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
                // ARQ's queues are a fixed fact of the worker's settings, not a
                // measurement: "4 queues" under a table that can never have a
                // fifth is a number the reader discards.
                countSummary={false}
                loading={queues.loading && queues.items.length === 0}
                empty={
                  <EmptyState
                    size="inline"
                    title="No queue reported"
                    description="Redis did not answer — the services strip above says whether it is reachable."
                  />
                }
              />
            </CardBody>
          </Card>
        </Section>

        <Section title="The numbers">
          <Card>
            <CardBody flush>
              <StatRow
                columns={4}
                label="Platform totals"
                // The strip's window is the one most of its tiles cover. The
                // three that genuinely cover another state it themselves — the
                // section used to be titled "The month" over five all-time
                // figures, which is a window stated three times and contradicted
                // by five of the eight numbers under it.
                period="All time"
                loading={centre.loading || stats.loading}
                items={[
                  {
                    label: 'Revenue',
                    period: 'This month',
                    size: 'lg',
                    value: centre.data
                      ? usdCentsRounded(centre.data.revenue_current_month_cents)
                      : undefined,
                    // The comparison is a comparison, and the window is the
                    // strip's. `period` used to carry both, which is what made
                    // the strip state its window nowhere.
                    hint: centre.data
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
                    label: 'Revenue, year to date',
                    period: 'This year',
                    size: 'lg',
                    value: centre.data
                      ? usdCentsRounded(centre.data.growth_current_year_cents)
                      : undefined,
                    hint: USD_NORMALISED_SHORT,
                  },
                  {
                    label: 'Signups',
                    period: 'This month',
                    value: centre.data
                      ? formatNumber(centre.data.signups_current_month)
                      : undefined,
                    hint: centre.data
                      ? `${formatNumber(centre.data.signups_last_month)} last month`
                      : undefined,
                  },
                  {
                    label: 'Accounts',
                    value: stats.data ? formatNumber(stats.data.total_clients) : undefined,
                  },
                  {
                    label: 'Conversations',
                    value: centre.data ? formatCompact(centre.data.chats_total) : undefined,
                  },
                  {
                    label: 'Handed to a person',
                    value: centre.data ? formatCompact(centre.data.operator_transfers) : undefined,
                  },
                  {
                    label: 'Qualified leads',
                    value: centre.data
                      ? formatCompact(centre.data.bant_qualified_leads)
                      : undefined,
                  },
                  {
                    label: 'Meetings booked',
                    value: centre.data ? formatNumber(centre.data.booked_meetings) : undefined,
                  },
                ]}
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
                <XAxis
                  dataKey="date"
                  tickFormatter={dayTick}
                  interval={tickInterval(chartData.length)}
                  {...CHART_AXIS}
                />
                <YAxis {...CHART_AXIS} tickFormatter={(value: number) => formatCompact(value)} width={48} />
                {/* The app's tooltip, not Recharts' default: the default is an
                    unthemed white box with a browser font that ignores the dark
                    palette entirely. */}
                <RechartsTooltip
                  cursor={CHART_CURSOR}
                  content={
                    <SeriesTooltip
                      name={METRICS.find((entry) => entry.value === metric)?.label ?? 'Revenue'}
                      format={(value) =>
                        // `chartData` already divides revenue by 100, so the
                        // tooltip has dollars and the formatter wants cents.
                        metric === 'revenue'
                          ? usdCentsRounded(Math.round(value * 100))
                          : formatNumber(Math.round(value))
                      }
                    />
                  }
                />
                <Area
                  type="monotone"
                  dataKey="value"
                  stroke={seriesColor(0)}
                  fill={seriesColor(0)}
                  fillOpacity={0.12}
                  strokeWidth={2}
                  // Off, like the customer console's activity chart: this page
                  // re-fetches on every Refresh, and a 400ms left-to-right draw
                  // on each one is a console that never settles.
                  isAnimationActive={false}
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
              <CardBody flush>
                {/* A table over whatever keys the payload carries, not
                    `JSON.stringify(items, null, 2)` in a `CodeBlock` — which is
                    what this was, and on a twelve-issue payload it printed
                    1,800px of pretty-printed JSON onto the first screen of the
                    console. This endpoint is the one list here with no schema,
                    so the columns are derived rather than guessed. */}
                <DataTable
                  seated
                  caption="Error issues reported by Sentry"
                  columns={errorColumns}
                  rows={errors.items}
                  rowKey={(row) => String(row.id ?? row.shortId ?? JSON.stringify(row))}
                  rowNoun="issue"
                  loading={errors.loading && errors.items.length === 0}
                  empty={<EmptyState size="inline" title="No errors" />}
                />
              </CardBody>
            )}
          </Card>
        </Section>
      </Stack>
    </PlatformPage>
  );
}
