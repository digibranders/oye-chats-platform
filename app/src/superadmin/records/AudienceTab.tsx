import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip as RechartsTooltip, XAxis, YAxis } from 'recharts';
import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  ChartFrame,
  EmptyState,
  Input,
  RankedBars,
  SearchField,
  SegmentedControl,
  Section,
  Skeleton,
  Stack,
  StatTile,
  Toolbar,
  formatDateTime,
  formatNumber,
  seriesColor,
  type Column,
} from '../../ui';
import { CHART_AXIS, CHART_GRID, CHART_MARGIN } from '../../ui/charts/theme';
import { usePlatformList, usePlatformResource, useUrlState } from '../usePlatform';
import { RecordList } from '../RecordList';
import { byDate, byText, includesText, usePagedRows } from '../recordList';
import { humanise, type GrowthEventRow, type VisitorAnalytics } from './types';

const VIEWS = [
  { value: 'visitors', label: 'Visitor behaviour' },
  { value: 'growth', label: 'Growth events' },
];

/** Who arrives, where from, and what the chatbots did about it. */
export function AudienceTab() {
  const url = useUrlState();
  const view = url.get('view', 'visitors');

  return (
    <Stack>
      <SegmentedControl
        label="Audience view"
        value={view}
        onChange={(next) => url.set({ view: next, q: null, bot_id: null })}
        items={VIEWS}
      />
      {view === 'growth' ? <GrowthEventsList /> : <VisitorAnalyticsPanel />}
    </Stack>
  );
}

/**
 * `GET /superadmin/visitors` is an aggregate, not a list.
 *
 * It answers with totals and four top-ten rankings, so it gets ranked bars and a
 * series rather than a table — and it is read through `usePlatformResource`,
 * because `toList` would find no array in it and hand back an empty envelope.
 */
function VisitorAnalyticsPanel() {
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
      <div className="grid gap-4 sm:grid-cols-2">
        <StatTile
          label="Behavioural events"
          value={data ? formatNumber(data.total_events) : undefined}
          period="All time"
          loading={record.loading}
        />
        <StatTile
          label="Distinct visitor sessions"
          value={data ? formatNumber(data.total_sessions) : undefined}
          period="All time"
          loading={record.loading}
        />
      </div>

      <Section
        title="Page views"
        description="Trailing 14 days, page views only. The endpoint fixes both the window and the event type."
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

      <div className="grid gap-4 lg:grid-cols-2">
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
      </div>
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
          <Skeleton className="h-32" />
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

function GrowthEventsList() {
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
    <div className="flex flex-col gap-4">
      <Toolbar>
        <div className="w-full max-w-xs">
          <SearchField
            label="Search growth events"
            value={query}
            onValueChange={(next) => url.set({ q: next })}
            placeholder="Event type or chatbot"
          />
        </div>
        <div className="w-40">
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
        columns={columns}
        paged={paged}
        rowKey={(row) => String(row.id)}
        loading={list.loading}
        error={list.error}
        forbidden={list.forbidden}
        onRetry={list.reload}
        loaded={list.items.length}
        cap={500}
        note="Demo-link distribution telemetry. Chatbot is filtered by the server; the search box filters the returned rows here."
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
    </div>
  );
}
