import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip as RechartsTooltip, XAxis, YAxis } from 'recharts';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  ChartFrame,
  EmptyState,
  Grid,
  LoadingBars,
  Input,
  RankedBars,
  SearchField,
  Section,
  Stack,
  StatRow,
  Toolbar,
  formatDateTime,
  formatNumber,
  seriesColor,
  type Column,
} from '../../ui';
import { CHART_AXIS, CHART_GRID, CHART_MARGIN } from '../../ui/charts/theme';
import { usePlatformList, usePlatformResource, useUrlState } from '../usePlatform';
import { RecordList } from '../RecordList';
import { byDate, byText, includesText, usePagedRows } from '../recordListState';
import { humanise, type GrowthEventRow, type VisitorAnalytics } from './types';

/**
 * `GET /superadmin/visitors` is an aggregate, not a list.
 *
 * It answers with totals and four top-ten rankings, so it gets ranked bars and a
 * series rather than a table — and it is read through `usePlatformResource`,
 * because `toList` would find no array in it and hand back an empty envelope.
 */
export function VisitorsTab() {
  const record = usePlatformResource<VisitorAnalytics>('/visitors');
  const data = record.data;

  const daily = (data?.daily ?? []).map((point) => ({ date: point.date, value: point.count }));
  const chartSummary =
    daily.length === 0
      ? 'No page views were recorded in the last 14 days.'
      : `Daily page views over the last 14 days: ${formatNumber(
          daily.reduce((sum, point) => sum + point.value, 0),
        )} in total, peaking at ${formatNumber(
          Math.max(...daily.map((point) => point.value)),
        )} on ${daily.reduce((best, point) => (point.value > best.value ? point : best), daily[0]).date}.`;

  if (record.forbidden) {
    return (
      <EmptyState
        title="You do not have access to visitor analytics"
        description="Your super-admin account is not permitted to read these aggregates. Nothing was loaded."
      />
    );
  }

  return (
    <Stack>
      <Card>
        <CardBody flush>
          <StatRow
            columns={2}
            label="Visitor telemetry"
            period="All time"
            loading={record.loading}
            items={[
              {
                label: 'Behavioural events',
                size: 'lg',
                value: data ? formatNumber(data.total_events) : undefined,
              },
              {
                label: 'Distinct visitor sessions',
                size: 'lg',
                value: data ? formatNumber(data.total_sessions) : undefined,
              },
            ]}
          />
        </CardBody>
      </Card>

      <Section
        title="Page views"
        description="Trailing 14 days, page views only — the endpoint fixes both."
      >
        <ChartFrame
          summary={chartSummary}
          loading={record.loading}
          error={record.error}
          onRetry={record.reload}
          empty={daily.length === 0}
          emptyTitle="No page views in the last 14 days"
          emptyDescription="Either no widget is embedded anywhere, or no visitor reached a page carrying one."
          height={220}
        >
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={daily} margin={CHART_MARGIN}>
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

      <Grid cols={2} align="start">
        <RankingCard
          title="Event types"
          description="Every behavioural event the widget has reported, all time."
          loading={record.loading}
          items={(data?.by_event_type ?? []).map((row) => ({
            id: row.event_type,
            label: humanise(row.event_type),
            value: row.count,
            display: formatNumber(row.count),
          }))}
          emptyTitle="No behavioural events"
          emptyDescription="No widget has reported a page view, a return visit or a UTM landing."
        />
        <RankingCard
          title="Countries"
          description="Top ten, read best-effort from the event payload. Events with no country are skipped."
          loading={record.loading}
          items={(data?.top_countries ?? []).map((row) => ({
            id: row.country,
            label: row.country,
            value: row.count,
            display: formatNumber(row.count),
          }))}
          emptyTitle="No country recorded"
          emptyDescription="No event carried a country in its payload."
        />
        <RankingCard
          title="Referrers"
          description="Top ten sites sending visitors to a page carrying a widget."
          loading={record.loading}
          items={(data?.top_referrers ?? []).map((row) => ({
            id: row.referrer,
            label: row.referrer,
            value: row.count,
            display: formatNumber(row.count),
          }))}
          emptyTitle="No referrer recorded"
          emptyDescription="Every visit arrived directly, or no event carried a referrer."
        />
        <RankingCard
          title="UTM sources"
          description="Top ten campaign sources across every workspace."
          loading={record.loading}
          items={(data?.top_utm_sources ?? []).map((row) => ({
            id: row.source,
            label: row.source,
            value: row.count,
            display: formatNumber(row.count),
          }))}
          emptyTitle="No campaign source recorded"
          emptyDescription="No visit arrived with a utm_source on the URL."
        />
      </Grid>
    </Stack>
  );
}

function RankingCard({
  title,
  description,
  items,
  loading,
  emptyTitle,
  emptyDescription,
}: {
  title: string;
  description: string;
  items: { id: string; label: string; value: number; display: string }[];
  loading: boolean;
  emptyTitle: string;
  emptyDescription: string;
}) {
  return (
    <Card>
      <CardHeader titleAs="h3" title={title} description={description} />
      {loading ? (
        <CardBody>
          <LoadingBars rows={5} />
        </CardBody>
      ) : items.length === 0 ? (
        <EmptyState compact title={emptyTitle} description={emptyDescription} />
      ) : (
        <CardBody>
          <RankedBars label={title} items={items} />
        </CardBody>
      )}
    </Card>
  );
}

export function GrowthEventsTab() {
  const url = useUrlState();
  const query = url.get('q');
  const botId = url.get('bot_id');
  const list = usePlatformList<GrowthEventRow>('/bot-growth-events', { params: { bot_id: botId } });

  const paged = usePagedRows(list.items, {
    url,
    filter: (row) => includesText([row.event_type, row.bot_name], query),
    comparators: {
      event_type: byText((row) => row.event_type),
      bot_name: byText((row) => row.bot_name),
      created_at: byDate((row) => row.created_at),
    },
  });

  const columns: Column<GrowthEventRow>[] = [
    {
      key: 'event_type',
      header: 'Event',
      pinned: true,
      sortable: true,
      render: (row) => <Badge>{humanise(row.event_type)}</Badge>,
    },
    {
      key: 'bot_name',
      header: 'Chatbot',
      sortable: true,
      render: (row) => row.bot_name ?? `#${row.bot_id}`,
    },
    {
      key: 'created_at',
      header: 'Recorded',
      sortable: true,
      render: (row) => formatDateTime(row.created_at),
    },
  ];

  return (
    <Stack>
      <Toolbar sticky>
        <div className="w-72 max-w-full">
          <SearchField
            label="Search growth events"
            value={query}
            onValueChange={(next) => url.set({ q: next })}
            placeholder="Event type or chatbot"
          />
        </div>
        <div className="w-48">
          <Input
            aria-label="Filter by chatbot id"
            inputMode="numeric"
            value={botId}
            onChange={(event) => url.set({ bot_id: event.target.value.replace(/\D/g, '') })}
            placeholder="Chatbot id"
          />
        </div>
      </Toolbar>
      <RecordList
        caption="Per-chatbot growth events"
        rowNoun="event"
        what="growth telemetry"
        columns={columns}
        paged={paged}
        rowKey={(row) => String(row.id)}
        loading={list.loading}
        error={list.error}
        forbidden={list.forbidden}
        onRetry={list.reload}
        loaded={list.items.length}
        cap={500}
        note="The search box filters the rows already loaded."
        empty={
          <EmptyState
            compact
            title={query || botId ? 'Nothing matched' : 'No growth events'}
            description={
              query || botId
                ? 'No growth event matches this filter.'
                : 'No chatbot has recorded a distribution event.'
            }
          />
        }
      />
    </Stack>
  );
}
