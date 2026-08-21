import { useMemo } from 'react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip as RechartsTooltip, XAxis, YAxis } from 'recharts';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ChartFrame,
  DataTable,
  EmptyState,
  LoadingRows,
  LockedState,
  RankedBars,
  Section,
  SegmentedControl,
  Stack,
  StatRow,
  formatCompact,
  formatMoney,
  formatNumber,
  seriesColor,
  type Column,
  type SegmentedItem,
} from '../../ui';
import { CHART_AXIS, CHART_CURSOR, CHART_GRID, CHART_MARGIN } from '../../ui/charts/theme';
import { SeriesTooltip } from '../SeriesTooltip';
import { dayTick, tickInterval } from '../chartTicks';
import { usePlatformList, usePlatformResource } from '../usePlatform';
import { PAGE_SIZE } from '../recordListState';
import type { LangfuseSummary, LlmCostRow, LlmUsageRow, SafetyNetMetrics } from './types';

/**
 * What the models cost, and how often they misbehave.
 *
 * Three read-only sources, in the order an operator asks about them: the daily
 * spend curve, who is spending it, and what the safety nets caught. Langfuse
 * sits at the bottom as a link out rather than as a second trace viewer — the
 * endpoint is a thin read-only proxy that returns whatever the Langfuse API
 * gave it, and re-rendering somebody else's trace UI badly is worse than saying
 * where the good one is.
 */

const RANGES: SegmentedItem<string>[] = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
];

/**
 * The safety-net counters, named for a reader.
 *
 * The endpoint returns an open map keyed by its own internal counter names, so
 * anything not listed here still renders — de-underscored and sentence-cased —
 * rather than disappearing.
 */
const SAFETY_LABELS: Record<string, string> = {
  rerank_applied: 'Reranked',
  relevance_gate_blocked: 'Blocked by the relevance gate',
  fallback_model_used: 'Fell back to the second model',
  empty_retrieval: 'Retrieved nothing',
  prompt_injection_flagged: 'Prompt injection flagged',
  groundedness_failed: 'Failed the groundedness check',
  refused: 'Refused',
};

function safetyLabel(key: string): string {
  const known = SAFETY_LABELS[key];
  if (known) return known;
  const words = key.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const DIMENSIONS: SegmentedItem<string>[] = [
  { value: 'model', label: 'By model' },
  { value: 'client', label: 'By account' },
];

interface AiScreenProps {
  days: string;
  by: string;
  onDaysChange: (value: string) => void;
  onByChange: (value: string) => void;
}

export function AiScreen({ days, by, onDaysChange, onByChange }: AiScreenProps) {
  const usage = usePlatformList<LlmUsageRow>('/llm/usage', { params: { days } });
  const breakdown = usePlatformList<LlmCostRow>('/llm/cost-breakdown', { params: { days, by } });
  const safety = usePlatformResource<SafetyNetMetrics>('/safety-net-metrics', { hours: 24 });
  const langfuse = usePlatformResource<LangfuseSummary>('/observability/langfuse', { days: 7 });

  // The endpoint returns one row per day per model, which is the shape the
  // breakdown wants and the wrong shape for a spend curve.
  const daily = useMemo(() => {
    const byDate = new Map<string, number>();
    for (const row of usage.items) {
      byDate.set(row.date, (byDate.get(row.date) ?? 0) + row.cost_cents);
    }
    return [...byDate.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, cents]) => ({ date, value: cents / 100 }));
  }, [usage.items]);

  const totals = useMemo(() => {
    let cost = 0;
    let calls = 0;
    let errors = 0;
    let fallbacks = 0;
    let latencyReported = false;
    let worstP95 = 0;
    for (const row of usage.items) {
      cost += row.cost_cents;
      calls += row.calls;
      errors += row.error_count ?? 0;
      fallbacks += row.fallback_count ?? 0;
      if (row.p95_latency_ms != null) {
        latencyReported = true;
        worstP95 = Math.max(worstP95, row.p95_latency_ms);
      }
    }
    return { cost, calls, errors, fallbacks, latencyReported, worstP95 };
  }, [usage.items]);

  const chartSummary =
    daily.length === 0
      ? `No LLM calls were metered in the last ${days} days.`
      : `LLM spend per day over the last ${days} days, in US dollars: ${formatMoney(totals.cost, 'USD')} in total across ${formatNumber(totals.calls)} calls, peaking at ${formatMoney(Math.round(Math.max(...daily.map((point) => point.value)) * 100), 'USD')} on ${daily.reduce((best, point) => (point.value > best.value ? point : best), daily[0]).date}.`;

  const bars = useMemo(
    () =>
      breakdown.items.slice(0, 10).map((row) => ({
        id: String(row.key ?? row.label ?? 'unattributed'),
        label: row.label ?? 'Unattributed',
        value: row.cost_cents,
        display: formatMoney(row.cost_cents, 'USD'),
        meta: `${formatCompact(row.calls)} calls · ${formatNumber(row.error_count)} errors`,
      })),
    [breakdown.items],
  );

  const safetyRows = useMemo(() => {
    const totalsMap = safety.data?.totals ?? {};
    return Object.entries(totalsMap)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  }, [safety.data]);

  const usageColumns: Column<LlmUsageRow>[] = [
    { key: 'date', header: 'Date', pinned: true, sortable: (a, b) => a.date.localeCompare(b.date), render: (row) => <span className="figure">{row.date}</span> },
    { key: 'model', header: 'Model', render: (row) => <span className="figure">{row.model}</span> },
    { key: 'calls', header: 'Calls', align: 'right', sortable: (a, b) => a.calls - b.calls, render: (row) => formatNumber(row.calls) },
    {
      key: 'tokens',
      header: 'Tokens in / out',
      align: 'right',
      secondary: true,
      render: (row) => `${formatCompact(row.prompt_tokens)} / ${formatCompact(row.completion_tokens)}`,
    },
    {
      key: 'cost',
      header: 'Cost',
      align: 'right',
      sortable: (a, b) => a.cost_cents - b.cost_cents,
      render: (row) => formatMoney(row.cost_cents, 'USD'),
    },
    {
      key: 'latency',
      header: 'p50 / p95',
      align: 'right',
      secondary: true,
      render: (row) =>
        row.p50_latency_ms == null && row.p95_latency_ms == null
          ? 'not reported'
          : `${row.p50_latency_ms ?? '—'} / ${row.p95_latency_ms ?? '—'} ms`,
    },
    {
      key: 'trouble',
      header: 'Fallbacks / errors',
      align: 'right',
      render: (row) =>
        row.fallback_count == null && row.error_count == null
          ? 'not reported'
          : `${formatNumber(row.fallback_count ?? 0)} / ${formatNumber(row.error_count ?? 0)}`,
    },
  ];

  if (usage.forbidden) {
    return (
      <LockedState
        title="You cannot read LLM metering"
        description="Your super-admin account is not permitted to load it."
      />
    );
  }

  return (
    <Stack>
      <Section
        title="Spend"
        description="Metered per call. Costs are US cents as the provider reported them."
        actions={
          <SegmentedControl size="sm" label="Range" value={days} onChange={onDaysChange} items={RANGES} />
        }
      >
        <Card>
          <CardBody flush>
            <StatRow
              label="Model spend"
              period={`Last ${days} days`}
              loading={usage.loading && usage.items.length === 0}
              items={[
                { label: 'Cost', size: 'hero', value: formatMoney(totals.cost, 'USD') },
                { label: 'Calls', value: formatNumber(totals.calls) },
                {
                  label: 'Fallbacks',
                  value: formatNumber(totals.fallbacks),
                  tone: totals.fallbacks > 0 ? 'warning' : 'neutral',
                },
                {
                  label: 'Errors',
                  value: formatNumber(totals.errors),
                  tone: totals.errors > 0 ? 'danger' : 'neutral',
                  invertTrend: true,
                },
              ]}
            />
          </CardBody>
          <CardBody>
            <ChartFrame
              summary={chartSummary}
              loading={usage.loading && usage.items.length === 0}
              error={usage.error}
              onRetry={usage.reload}
              empty={daily.length === 0}
              emptyTitle="No metered calls in this window"
              emptyDescription="Either nothing ran, or the metering table has no rows for it."
              height={220}
            >
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={daily} margin={CHART_MARGIN}>
                  <CartesianGrid {...CHART_GRID} />
                  <XAxis
                    dataKey="date"
                    tickFormatter={dayTick}
                    interval={tickInterval(daily.length)}
                    {...CHART_AXIS}
                  />
                  <YAxis {...CHART_AXIS} width={48} />
                  {/* The app's tooltip. Recharts' default is an unthemed white
                      panel that stays white on the dark theme. */}
                  <RechartsTooltip
                    cursor={CHART_CURSOR}
                    content={
                      <SeriesTooltip
                        name="Spend"
                        // `daily` already divides by 100, so this has dollars.
                        format={(value) => formatMoney(Math.round(value * 100), 'USD')}
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
                    // Off, like the customer console's activity chart: a
                    // left-to-right redraw on every range change is a console
                    // that never settles.
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </ChartFrame>
          </CardBody>
          {!totals.latencyReported && usage.items.length > 0 ? (
            <CardBody className="border-t border-border">
              <Alert tone="neutral" title="Latency and error counts were not reported">
                The metering query has a simpler fallback path that drops the percentiles and the fallback
                and error columns. That is what happened for this window.
              </Alert>
            </CardBody>
          ) : null}
        </Card>
      </Section>

      <Section
        title="Where the cost sits"
        description="Ordered by spend. An account with no name is shown as unattributed rather than as a blank row."
        actions={
          <SegmentedControl size="sm" label="Group by" value={by} onChange={onByChange} items={DIMENSIONS} />
        }
      >
        <Card>
          <CardBody>
            {breakdown.loading && breakdown.items.length === 0 ? (
              <LoadingRows rows={5} />
            ) : breakdown.error ? (
              <Alert
                tone="danger"
                title="The breakdown could not be loaded"
                action={
                  <Button size="sm" onClick={breakdown.reload}>
                    Try again
                  </Button>
                }
              >
                {breakdown.error}
              </Alert>
            ) : bars.length === 0 ? (
              <EmptyState
                compact
                title="Nothing to attribute"
                description="No metered calls fell inside this window."
              />
            ) : (
              <RankedBars items={bars} label={`LLM cost by ${by}`} />
            )}
          </CardBody>
        </Card>
      </Section>

      <Section title="Daily metering" description="One row per day per model, as the endpoint returns it.">
        <DataTable
          caption="LLM usage by day and model"
          columns={usageColumns}
          rows={usage.items}
          rowKey={(row) => `${row.date}:${row.model}`}
          rowLabel={(row) => `${row.model} on ${row.date}`}
          rowNoun="day"
          loading={usage.loading && usage.items.length === 0}
          error={usage.error}
          onRetry={usage.reload}
          pageSize={PAGE_SIZE}
          defaultSort={{ key: 'date', direction: 'desc' }}
          empty={
            <EmptyState
              title="No calls were metered"
              description="Nothing ran in this window, or llm_call_logs has no rows for it."
            />
          }
        />
      </Section>

      <Section
        title="Safety nets"
        description="Refusals, groundedness checks, injection attempts and call outcomes, over 24 hours."
      >
        <Card>
          {safety.forbidden ? (
            <EmptyState compact title="Not permitted" description="Your account cannot read these counters." />
          ) : safety.loading && !safety.data ? (
            <CardBody>
              <LoadingRows rows={4} />
            </CardBody>
          ) : safety.error ? (
            <CardBody>
              <Alert
                tone="danger"
                title="The counters could not be loaded"
                action={
                  <Button size="sm" onClick={safety.reload}>
                    Try again
                  </Button>
                }
              >
                {safety.error}
              </Alert>
            </CardBody>
          ) : safetyRows.every((row) => row.count === 0) ? (
            <EmptyState
              compact
              title="Nothing fired in the last 24 hours"
              description="Every safety-net counter is zero. That is the healthy reading, not a missing one."
            />
          ) : (
            <CardBody flush>
              {/* `StatRow`, not a second hand-rolled tile shape 200px below the
                  first one on the same page. */}
              <StatRow
                columns={3}
                label="Safety-net counters"
                period="Last 24 hours"
                // Humanised. The endpoint's keys are its own — `rerank_applied`,
                // `prompt_injection_flagged` — and five raw snake_case strings
                // were the only labels in the console not written for a reader.
                items={safetyRows
                  .filter((row) => row.count > 0)
                  .map((row) => ({ label: safetyLabel(row.name), value: formatNumber(row.count) }))}
              />
            </CardBody>
          )}
        </Card>
      </Section>

      <Section title="Traces" description="Langfuse, read through a read-only proxy so the SDK stays off the server.">
        <Card>
          <CardHeader
            titleAs="h3"
            title="Langfuse"
            description="Whether tracing is reachable, and how much it holds."
            actions={
              langfuse.data?.configured ? (
                <Badge tone="success" dot>
                  Configured
                </Badge>
              ) : (
                <Badge tone="neutral" dot>
                  Not configured
                </Badge>
              )
            }
          />
          <CardBody>
            {langfuse.loading && !langfuse.data ? (
              <LoadingRows rows={2} />
            ) : langfuse.error && !langfuse.data ? (
              <Alert
                tone="danger"
                title="The observability summary could not be loaded"
                action={
                  <Button size="sm" onClick={langfuse.reload}>
                    Try again
                  </Button>
                }
              >
                {langfuse.error}
              </Alert>
            ) : langfuse.data && !langfuse.data.configured ? (
              <EmptyState
                compact
                title="Tracing is not configured"
                description={langfuse.data.error ?? 'No Langfuse keys are set, so no traces are being written.'}
              />
            ) : langfuse.data ? (
              <div className="flex flex-col gap-3">
                <StatRow
                  columns={3}
                  label="Tracing volume"
                  period="Last 7 days"
                  items={[
                    {
                      label: 'Recent traces',
                      value: formatNumber(langfuse.data.recent_traces.length),
                    },
                    { label: 'Scores', value: formatNumber(langfuse.data.scores.length) },
                    {
                      label: 'Daily metric rows',
                      value: formatNumber(langfuse.data.daily_metrics.length),
                    },
                  ]}
                />
                {langfuse.data.error ? (
                  <Alert tone="warning" title="Langfuse answered partially">
                    {langfuse.data.error}
                  </Alert>
                ) : null}
                {langfuse.data.host ? (
                  <p className="figure text-xs text-text-tertiary">{langfuse.data.host}</p>
                ) : null}
              </div>
            ) : null}
          </CardBody>
        </Card>
      </Section>
    </Stack>
  );
}
