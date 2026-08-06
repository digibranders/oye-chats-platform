import { type KeyboardEvent, type ReactElement, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  BarChart3,
  Bot as BotIcon,
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
  MetricCard,
  type MetricTrend,
  PageContainer,
  SectionHeader,
  Skeleton,
  Tabs,
} from '../../design-system';
import { useBotContext } from '../../context/BotContext';
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

/**
 * Segmented control for picking the trend window. A one-of-N choice, so it is
 * modelled as a WAI-ARIA radio group (`role="radiogroup"` + `role="radio"` /
 * `aria-checked`) with roving `tabIndex` and arrow / Home / End navigation -
 * this reads as a mutually-exclusive selection to assistive tech rather than a
 * row of independent toggles.
 */
function RangeControl({
  value,
  onChange,
}: {
  value: TrendRange;
  onChange: (range: TrendRange) => void;
}): ReactElement {
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function selectAt(index: number): void {
    const range = TREND_RANGES[index];
    if (!range) return;
    buttonRefs.current[index]?.focus();
    onChange(range.id);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    const count = TREND_RANGES.length;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        selectAt((index + 1) % count);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        selectAt((index - 1 + count) % count);
        break;
      case 'Home':
        event.preventDefault();
        selectAt(0);
        break;
      case 'End':
        event.preventDefault();
        selectAt(count - 1);
        break;
      default:
        break;
    }
  }

  return (
    <div
      className="inline-flex items-center gap-1 rounded-lg bg-[var(--ds-bg-sunken)] p-1"
      role="radiogroup"
      aria-label="Message trend time range"
    >
      {TREND_RANGES.map((range, index) => {
        const selected = range.id === value;
        return (
          <button
            key={range.id}
            ref={(node) => {
              buttonRefs.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(range.id)}
            onKeyDown={(event) => handleKeyDown(event, index)}
            className={
              selected
                ? 'rounded-md bg-[var(--ds-bg-surface)] px-2.5 py-1 text-[12px] font-semibold text-[var(--ds-text)] shadow-[var(--ds-shadow-sm)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]'
                : 'rounded-md px-2.5 py-1 text-[12px] font-medium text-[var(--ds-text-muted)] transition-colors hover:text-[var(--ds-text)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]'
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
            tabs={TAB_ITEMS.map((item) => ({ key: item.key, label: item.label }))}
            value={tab}
            onChange={(key) => {
              if (isAnalyticsTab(key)) setTab(key);
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
              <LeadJourneyFunnel botId={selectedBot?.id ?? null} />
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
