import { type ReactElement, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  BarChart3,
  Bot as BotIcon,
  Lock,
  MessageSquare,
  RefreshCw,
  Sparkles,
  TriangleAlert,
  Zap,
} from 'lucide-react';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  EmptyState,
  InsightCard,
  type InsightTone,
  LockedFeatureCard,
  MetricCard,
  type MetricTrend,
  PageContainer,
  SectionHeader,
  SegmentedControl,
  type SegmentedOption,
  Skeleton,
  Tabs,
} from '../../design-system';
import { useBotContext } from '../../context/BotContext';
import { useEntitlements } from '../../hooks/useEntitlements';
import { useUpgradeModal } from '../../context/UpgradeModalContext';
import {
  MOMENTUM_WINDOW_DAYS,
  sliceTrend,
  summarizeTrend,
  TREND_RANGES,
  type TrendRange,
  weekOverWeekChange,
} from './analytics-types';
import { useWorkspaceAnalytics, type WorkspaceAnalytics } from './useWorkspaceAnalytics';
import { MessageTrendChart } from './MessageTrendChart';
import { TopQuestionsList } from './TopQuestionsList';
import { LeadJourneyFunnel } from './LeadJourneyFunnel';
import { SatisfactionBreakdown } from './SatisfactionBreakdown';
import { FeedbackPanel } from '../feedback/FeedbackPanel';

type AnalyticsTab = 'conversations' | 'leads' | 'satisfaction' | 'feedback';

const TAB_ITEMS: ReadonlyArray<{ key: AnalyticsTab; label: string }> = [
  { key: 'conversations', label: 'Conversations' },
  { key: 'leads', label: 'Leads' },
  { key: 'satisfaction', label: 'Satisfaction' },
  { key: 'feedback', label: 'Feedback' },
];

/** Narrow the Tabs string key back to the AnalyticsTab union without casting. */
function isAnalyticsTab(key: string): key is AnalyticsTab {
  return TAB_ITEMS.some((item) => item.key === key);
}

/**
 * Map a signed week-over-week percentage change onto a MetricCard trend
 * direction. The delta is labelled with its reference window (`· 7d`) so the
 * headline figure reads as a well-defined period-over-period comparison rather
 * than an unqualified percentage.
 */
function trendFromChange(change: number | null): { delta?: string; trend?: MetricTrend } {
  if (change === null) return {};
  if (change === 0) return { delta: `No change · ${MOMENTUM_WINDOW_DAYS}d`, trend: 'flat' };
  const sign = change > 0 ? '+' : '';
  return {
    delta: `${sign}${change}% · ${MOMENTUM_WINDOW_DAYS}d`,
    trend: change > 0 ? 'up' : 'down',
  };
}

/** A single derived headline insight, or null when there isn't enough signal. */
function deriveInsight(
  data: WorkspaceAnalytics,
): { tone: InsightTone; title: string; body: string } | null {
  const { totals, leads } = data;

  if (totals.totalConversations === 0) return null;

  if (leads.sql > 0) {
    return {
      tone: 'accent',
      title: `${leads.sql.toLocaleString()} ready-to-buy ${leads.sql === 1 ? 'lead' : 'leads'} captured`,
      body: 'Your agents are turning conversations into qualified pipeline. Review them in Leads to follow up.',
    };
  }

  return null;
}

/** The trend windows as `SegmentedControl` options. */
const TREND_RANGE_OPTIONS: ReadonlyArray<SegmentedOption<TrendRange>> = TREND_RANGES.map(
  (range) => ({ value: range.id, label: range.label }),
);

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
 * AnalyticsPage - the workspace performance surface (route `/analytics`).
 * Answers one question: "How is my workspace performing?" It aggregates every
 * agent (no bot filter) into headline metrics, a message-volume trend, and
 * three progressive-disclosure tabs (Conversations · Leads · Satisfaction).
 */
export function AnalyticsPage(): ReactElement {
  const { bots, selectedBot, loading: botsLoading } = useBotContext();
  // When the shell BotSwitcher is set to a specific agent, scope the whole
  // page to that bot; when it's on "All agents" (`selectedBot === null`), fall
  // back to workspace-aggregated across every agent.
  const { status, data, error, refreshing, reload } = useWorkspaceAnalytics(selectedBot?.id ?? null);
  const [tab, setTab] = useState<AnalyticsTab>('conversations');
  const [range, setRange] = useState<TrendRange>('all');
  const { hasFeature } = useEntitlements();
  const { openUpgradeModal } = useUpgradeModal();
  // Leads is BANT-derived (Standard+) — Free / Starter see a lock chip on the
  // tab and the panel body swaps to the upgrade card.
  // Satisfaction is CSAT gathered from live-chat post-chat ratings, so it
  // travels with the `live_chat` feature (Starter and up). Only Free is
  // locked here — Starter accumulates real ratings and should see them.
  const leadsUnlocked = hasFeature('bant');
  const satisfactionUnlocked = hasFeature('live_chat');

  const tabItems = useMemo(
    () =>
      TAB_ITEMS.map((item) => {
        const locked =
          (item.key === 'leads' && !leadsUnlocked) ||
          (item.key === 'satisfaction' && !satisfactionUnlocked);
        if (!locked) return { key: item.key, label: item.label };
        return {
          key: item.key,
          label: (
            <span className="inline-flex items-center gap-1.5">
              <Lock
                size={11}
                strokeWidth={1.75}
                aria-hidden="true"
                className="text-[var(--ds-text-subtle)]"
              />
              {item.label}
            </span>
          ),
        };
      }),
    [leadsUnlocked, satisfactionUnlocked],
  );

  const trendWindow = useMemo(
    () => (data ? sliceTrend(data.trend, range) : []),
    [data, range],
  );
  const trendSummary = useMemo(() => summarizeTrend(trendWindow), [trendWindow]);

  const showLoading = botsLoading || status === 'loading';

  const actions =
    status === 'ready' ? (
      <Button variant="outline" size="sm" onClick={reload} disabled={refreshing}>
        <RefreshCw
          size={15}
          aria-hidden="true"
          className={refreshing ? 'animate-spin' : undefined}
        />
        {refreshing ? 'Refreshing…' : 'Refresh'}
      </Button>
    ) : undefined;

  // No agents at all → nothing to measure yet. Send them to create one.
  if (!botsLoading && bots.length === 0) {
    return (
      <PageContainer
        title="Analytics"
      >
        <EmptyState
          icon={BarChart3}
          title="No performance data yet"
          description="Create your first AI chatbot and deploy it to start tracking conversations, leads, and satisfaction here."
          action={
            <Link
              to="/agents"
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-[var(--ds-accent)] px-4 text-sm font-medium text-[var(--ds-accent-fg)] shadow-[var(--ds-shadow-sm)] transition-colors hover:bg-[var(--ds-accent-hover)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]"
            >
              <BotIcon size={16} aria-hidden="true" />
              Create an AI chatbot
            </Link>
          }
        />
      </PageContainer>
    );
  }

  const insight = data ? deriveInsight(data) : null;
  // Momentum is a fixed 7d-vs-prior-7d figure over the full series, so it stays
  // comparable no matter which range the user has selected below.
  const messagesTrend = trendFromChange(data ? weekOverWeekChange(data.trend) : null);

  return (
    <PageContainer
      title="Analytics"
      description="How your whole workspace is performing across every AI chatbot."
      actions={actions}
    >
      {showLoading ? (
        <LoadingState />
      ) : status === 'error' || !data ? (
        <ErrorState message={error ?? 'Something went wrong.'} onRetry={reload} />
      ) : (
        <>
          {insight && (
            <InsightCard tone={insight.tone} icon={Sparkles} title={insight.title} body={insight.body} />
          )}

          <Tabs
            tabs={tabItems}
            value={tab}
            onChange={(key) => {
              if (!isAnalyticsTab(key)) return;
              if (key === 'leads' && !leadsUnlocked) {
                openUpgradeModal('view_qualification');
                return;
              }
              if (key === 'satisfaction' && !satisfactionUnlocked) {
                openUpgradeModal('view_qualification');
                return;
              }
              setTab(key);
            }}
            ariaLabel="Analytics views"
          />

          {/* Conversations */}
          {tab === 'conversations' && (
            <div
              role="tabpanel"
              id="tabpanel-conversations"
              aria-labelledby="tab-conversations"
              tabIndex={0}
              className="space-y-6 focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]"
            >
              <Card>
                <CardHeader>
                  <SectionHeader
                    title="Message volume"
                    description="Daily messages across every agent"
                    actions={
                      <SegmentedControl
                        options={TREND_RANGE_OPTIONS}
                        value={range}
                        onChange={setRange}
                        ariaLabel="Message trend time range"
                      />
                    }
                  />
                </CardHeader>
                <CardContent className="pt-0">
                  <div className="mb-4 grid grid-cols-3 gap-3">
                    <MetricCard
                      size="sm"
                      label="Messages"
                      value={trendSummary.total.toLocaleString()}
                      icon={MessageSquare}
                      delta={messagesTrend.delta}
                      trend={messagesTrend.trend}
                    />
                    <MetricCard
                      size="sm"
                      label="Daily average"
                      value={trendSummary.dailyAverage.toLocaleString()}
                      icon={BarChart3}
                    />
                    <MetricCard
                      size="sm"
                      label="Busiest day"
                      value={
                        trendSummary.peak > 0
                          ? `${trendSummary.peak.toLocaleString()} · ${trendSummary.peakLabel}`
                          : trendSummary.peak.toLocaleString()
                      }
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
              tabIndex={0}
              className="space-y-6 focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]"
            >
              {leadsUnlocked ? (
                <LeadJourneyFunnel botId={selectedBot?.id ?? null} />
              ) : (
                <LockedFeatureCard intent="view_qualification" />
              )}
            </div>
          )}

          {/* Satisfaction */}
          {tab === 'satisfaction' && (
            <div
              role="tabpanel"
              id="tabpanel-satisfaction"
              aria-labelledby="tab-satisfaction"
              tabIndex={0}
              className="space-y-6 focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]"
            >
              {satisfactionUnlocked ? (
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
              ) : (
                <LockedFeatureCard intent="view_qualification" />
              )}
            </div>
          )}

          {/* Feedback */}
          {tab === 'feedback' && (
            <div
              role="tabpanel"
              id="tabpanel-feedback"
              aria-labelledby="tab-feedback"
              tabIndex={0}
              className="focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]"
            >
              <FeedbackPanel agentId={selectedBot ? String(selectedBot.id) : undefined} />
            </div>
          )}
        </>
      )}
    </PageContainer>
  );
}
