import { type ReactElement, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  BarChart3,
  Bot as BotIcon,
  MessageSquare,
  RefreshCw,
  Sparkles,
  TriangleAlert,
  Users,
  Zap,
} from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  EmptyState,
  PageContainer,
  SectionHeader,
  Skeleton,
} from '../../design-system';
// Foundation-phase components are consumed directly from their files: the
// design-system barrel is orchestrator-owned and doesn't re-export them yet.
import { MetricCard, type MetricTrend } from '../../design-system/components/MetricCard';
import { InsightCard, type InsightTone } from '../../design-system/components/InsightCard';
import { Tabs } from '../../design-system/components/Tabs';
import { useBotContext } from '../../context/BotContext';
import {
  sliceTrend,
  summarizeTrend,
  TREND_RANGES,
  type TrendRange,
} from './analytics-types';
import { useWorkspaceAnalytics, type WorkspaceAnalytics } from './useWorkspaceAnalytics';
import { MessageTrendChart } from './MessageTrendChart';
import { TopQuestionsList } from './TopQuestionsList';
import { LeadFunnel } from './LeadFunnel';
import { SatisfactionBreakdown } from './SatisfactionBreakdown';

type AnalyticsTab = 'conversations' | 'leads' | 'satisfaction';

const TAB_ITEMS: ReadonlyArray<{ key: AnalyticsTab; label: string }> = [
  { key: 'conversations', label: 'Conversations' },
  { key: 'leads', label: 'Leads' },
  { key: 'satisfaction', label: 'Satisfaction' },
];

/** Map a signed percentage change onto a MetricCard trend direction. */
function trendFromChange(change: number | null): { delta?: string; trend?: MetricTrend } {
  if (change === null) return {};
  if (change === 0) return { delta: 'No change', trend: 'flat' };
  const sign = change > 0 ? '+' : '';
  return { delta: `${sign}${change}%`, trend: change > 0 ? 'up' : 'down' };
}

/** A single derived headline insight, or null when there isn't enough signal. */
function deriveInsight(
  data: WorkspaceAnalytics,
): { tone: InsightTone; title: string; body: string } | null {
  const { totals, ratings, leads } = data;

  if (totals.totalConversations === 0) return null;

  if (totals.answerRate > 0 && totals.answerRate < 60) {
    return {
      tone: 'warning',
      title: `Your AI is resolving ${Math.round(totals.answerRate)}% of conversations on its own`,
      body: 'A lower self-serve rate often means gaps in your knowledge base. Adding more content usually lifts it.',
    };
  }

  if (totals.answerRate >= 80) {
    return {
      tone: 'success',
      title: `Your AI handled ${Math.round(totals.answerRate)}% of conversations without help`,
      body: 'Visitors are getting answered instantly. Keep your knowledge fresh to hold this level.',
    };
  }

  if (leads.sql > 0) {
    return {
      tone: 'accent',
      title: `${leads.sql.toLocaleString()} sales-qualified ${leads.sql === 1 ? 'lead' : 'leads'} captured`,
      body: 'Your agents are turning conversations into qualified pipeline. Review them in Leads to follow up.',
    };
  }

  if (ratings.total > 0) {
    return {
      tone: ratings.average >= 4 ? 'success' : 'info',
      title: `Visitors rate their experience ${ratings.average.toFixed(1)} out of 5`,
      body: `Based on ${ratings.total.toLocaleString()} post-chat ${ratings.total === 1 ? 'rating' : 'ratings'} across your agents.`,
    };
  }

  return null;
}

/** Segmented control for picking the trend window. */
function RangeControl({
  value,
  onChange,
}: {
  value: TrendRange;
  onChange: (range: TrendRange) => void;
}): ReactElement {
  return (
    <div
      className="inline-flex items-center gap-1 rounded-lg bg-[var(--ds-bg-sunken)] p-1"
      role="group"
      aria-label="Message trend time range"
    >
      {TREND_RANGES.map((range) => {
        const selected = range.id === value;
        return (
          <button
            key={range.id}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(range.id)}
            className={
              selected
                ? 'rounded-md bg-[var(--ds-bg-surface)] px-2.5 py-1 text-[12px] font-semibold text-[var(--ds-text)] shadow-[var(--ds-shadow-sm)]'
                : 'rounded-md px-2.5 py-1 text-[12px] font-medium text-[var(--ds-text-muted)] transition-colors hover:text-[var(--ds-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)]'
            }
          >
            {range.label}
          </button>
        );
      })}
    </div>
  );
}

function LoadingState(): ReactElement {
  return (
    <div className="space-y-6" aria-busy="true">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-[104px]" />
        ))}
      </div>
      <Skeleton className="h-10 w-72" />
      <Skeleton className="h-[360px]" />
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }): ReactElement {
  return (
    <EmptyState
      icon={TriangleAlert}
      title="We couldn’t load your analytics"
      description={message}
      action={
        <Button variant="primary" onClick={onRetry}>
          <RefreshCw size={16} aria-hidden="true" />
          Try again
        </Button>
      }
    />
  );
}

/**
 * AnalyticsPage — the workspace performance surface (route `/analytics`).
 * Answers one question: "How is my workspace performing?" It aggregates every
 * agent (no bot filter) into headline metrics, a message-volume trend, and
 * three progressive-disclosure tabs (Conversations · Leads · Satisfaction).
 */
export function AnalyticsPage(): ReactElement {
  const { bots, loading: botsLoading } = useBotContext();
  const { status, data, error, reload } = useWorkspaceAnalytics();
  const [tab, setTab] = useState<AnalyticsTab>('conversations');
  const [range, setRange] = useState<TrendRange>('all');

  const trendWindow = useMemo(
    () => (data ? sliceTrend(data.trend, range) : []),
    [data, range],
  );
  const trendSummary = useMemo(() => summarizeTrend(trendWindow), [trendWindow]);

  const showLoading = botsLoading || status === 'loading';

  const actions =
    status === 'ready' ? (
      <Button variant="outline" size="sm" onClick={reload}>
        <RefreshCw size={15} aria-hidden="true" />
        Refresh
      </Button>
    ) : undefined;

  // No agents at all → nothing to measure yet. Send them to create one.
  if (!botsLoading && bots.length === 0) {
    return (
      <PageContainer
        title="Analytics"
        description="How your whole workspace is performing across every AI agent."
      >
        <EmptyState
          icon={BarChart3}
          title="No performance data yet"
          description="Create your first AI agent and deploy it to start tracking conversations, leads, and satisfaction here."
          action={
            <Link
              to="/agents"
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-[var(--ds-accent)] px-4 text-sm font-medium text-[var(--ds-accent-fg)] shadow-[var(--ds-shadow-sm)] transition-colors hover:bg-[var(--ds-accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ds-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--ds-bg-canvas)]"
            >
              <BotIcon size={16} aria-hidden="true" />
              Create an AI agent
            </Link>
          }
        />
      </PageContainer>
    );
  }

  const insight = data ? deriveInsight(data) : null;
  const messagesTrend = trendFromChange(trendSummary.changePercent);

  return (
    <PageContainer
      title="Analytics"
      description="How your whole workspace is performing across every AI agent."
      actions={actions}
    >
      {showLoading ? (
        <LoadingState />
      ) : status === 'error' || !data ? (
        <ErrorState message={error ?? 'Something went wrong.'} onRetry={reload} />
      ) : (
        <>
          {/* Headline workspace totals (all agents, all time). */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard
              label="Conversations"
              value={data.totals.totalConversations.toLocaleString()}
              icon={MessageSquare}
            />
            <MetricCard
              label="Messages"
              value={data.totals.totalMessages.toLocaleString()}
              icon={Activity}
            />
            <MetricCard
              label="Active visitors"
              value={data.totals.activeVisitors.toLocaleString()}
              icon={Users}
            />
            <MetricCard
              label="Answer rate"
              value={`${Math.round(data.totals.answerRate)}%`}
              icon={Zap}
            />
          </div>

          {insight && (
            <InsightCard tone={insight.tone} icon={Sparkles} title={insight.title} body={insight.body} />
          )}

          <Tabs
            tabs={TAB_ITEMS.map((item) => ({ key: item.key, label: item.label }))}
            value={tab}
            onChange={(key) => setTab(key as AnalyticsTab)}
            ariaLabel="Analytics views"
          />

          {/* Conversations */}
          {tab === 'conversations' && (
            <div
              role="tabpanel"
              id="tabpanel-conversations"
              aria-labelledby="tab-conversations"
              className="space-y-6"
            >
              <Card>
                <CardHeader>
                  <SectionHeader
                    title="Message volume"
                    description="Daily messages across every agent"
                    actions={<RangeControl value={range} onChange={setRange} />}
                  />
                </CardHeader>
                <CardContent className="pt-0">
                  <div className="mb-5 grid grid-cols-3 gap-4">
                    <MetricCard
                      label="Messages"
                      value={trendSummary.total.toLocaleString()}
                      icon={MessageSquare}
                      delta={messagesTrend.delta}
                      trend={messagesTrend.trend}
                    />
                    <MetricCard
                      label="Daily average"
                      value={trendSummary.dailyAverage.toLocaleString()}
                      icon={BarChart3}
                    />
                    <MetricCard
                      label="Busiest day"
                      value={trendSummary.peak.toLocaleString()}
                      delta={trendSummary.peak > 0 ? trendSummary.peakLabel : undefined}
                      trend={trendSummary.peak > 0 ? 'flat' : undefined}
                      icon={Zap}
                    />
                  </div>
                  {trendWindow.length === 0 || trendSummary.total === 0 ? (
                    <EmptyState
                      icon={Activity}
                      title="No messages in this range"
                      description="Try a wider time range, or come back once your agents have handled more conversations."
                    />
                  ) : (
                    <MessageTrendChart points={trendWindow} />
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <SectionHeader
                    title="Top questions"
                    description="What visitors ask your agents most"
                  />
                </CardHeader>
                <CardContent className="pt-0">
                  <TopQuestionsList questions={data.topQuestions} />
                </CardContent>
              </Card>
            </div>
          )}

          {/* Leads */}
          {tab === 'leads' && (
            <div
              role="tabpanel"
              id="tabpanel-leads"
              aria-labelledby="tab-leads"
              className="space-y-6"
            >
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                <MetricCard label="Total leads" value={data.leads.total.toLocaleString()} icon={Users} />
                <MetricCard label="Marketing-qualified" value={data.leads.mql.toLocaleString()} icon={Sparkles} />
                <MetricCard label="Sales-accepted" value={data.leads.sal.toLocaleString()} icon={Activity} />
                <MetricCard label="Sales-qualified" value={data.leads.sql.toLocaleString()} icon={Zap} />
              </div>
              <Card>
                <CardHeader>
                  <SectionHeader
                    title="Qualification funnel"
                    description="How visitors progress from first contact to sales-ready"
                  />
                </CardHeader>
                <CardContent className="pt-0">
                  <LeadFunnel stats={data.leads} />
                </CardContent>
              </Card>
            </div>
          )}

          {/* Satisfaction */}
          {tab === 'satisfaction' && (
            <div
              role="tabpanel"
              id="tabpanel-satisfaction"
              aria-labelledby="tab-satisfaction"
              className="space-y-6"
            >
              <Card>
                <CardHeader>
                  <SectionHeader
                    title="Visitor satisfaction"
                    description="Post-chat ratings from live conversations, across every agent"
                  />
                </CardHeader>
                <CardContent className="pt-0">
                  <SatisfactionBreakdown ratings={data.ratings} />
                </CardContent>
              </Card>
            </div>
          )}
        </>
      )}
    </PageContainer>
  );
}
