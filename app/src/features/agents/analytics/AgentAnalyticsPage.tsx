import { useMemo, useState, type ReactElement } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  MessageSquare,
  Rocket,
  Sparkles,
  Star,
  ThumbsUp,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { Button, EmptyState, PageContainer, Skeleton } from '../../../design-system';
import { MetricCard } from '../../../design-system/components/MetricCard';
import { InsightCard, type InsightTone } from '../../../design-system/components/InsightCard';
import { Tabs, type TabItem } from '../../../design-system/components/Tabs';
import { useAgent } from '../../../context/AgentContext';
import { useAgentAnalytics, type AgentAnalytics } from './useAgentAnalytics';
import { EngagementChart } from './EngagementChart';
import { TopQuestions } from './TopQuestions';
import { LeadsBreakdown } from './LeadsBreakdown';
import { SatisfactionBreakdown } from './SatisfactionBreakdown';

type PanelKey = 'engagement' | 'questions' | 'leads' | 'satisfaction';

const PANELS: readonly TabItem[] = [
  { key: 'engagement', label: 'Engagement' },
  { key: 'questions', label: 'Questions' },
  { key: 'leads', label: 'Leads' },
  { key: 'satisfaction', label: 'Satisfaction' },
];

/** Narrow the Tabs `(key: string)` callback back to the panel union safely. */
function isPanelKey(key: string): key is PanelKey {
  return PANELS.some((panel) => panel.key === key);
}

interface Insight {
  title: string;
  body: string;
  tone: InsightTone;
  icon: LucideIcon;
}

function computeInsight(data: AgentAnalytics, totalMessages: number): Insight {
  const { ratings, resolution, leads } = data;
  const hasAnything =
    totalMessages > 0 ||
    (leads?.total ?? 0) > 0 ||
    ratings.total > 0 ||
    resolution.total > 0 ||
    data.topQuestions.length > 0;

  if (!hasAnything) {
    return {
      title: 'No conversations yet',
      body: 'Once your agent is deployed and visitors start chatting, performance insights will appear here automatically.',
      tone: 'info',
      icon: Rocket,
    };
  }

  if (ratings.total > 0 && ratings.avg !== null) {
    const strong = ratings.avg >= 4;
    return {
      title: `Visitors rate this agent ${ratings.avg} out of 5`,
      body: strong
        ? `Across ${ratings.total.toLocaleString()} rated chat${ratings.total === 1 ? '' : 's'}, satisfaction is strong. Keep your knowledge fresh to hold the score.`
        : `Across ${ratings.total.toLocaleString()} rated chat${ratings.total === 1 ? '' : 's'}, there's room to improve. Review low-rated chats and fill knowledge gaps.`,
      tone: strong ? 'success' : 'warning',
      icon: strong ? ThumbsUp : Star,
    };
  }

  if (resolution.total > 0 && resolution.rate !== null) {
    return {
      title: `${resolution.rate}% of answered chats were resolved`,
      body: `Based on ${resolution.total.toLocaleString()} response${resolution.total === 1 ? '' : 's'}. Unresolved chats are the fastest place to improve your AI.`,
      tone: resolution.rate >= 70 ? 'success' : 'warning',
      icon: CheckCircle2,
    };
  }

  return {
    title: `Your AI has handled ${totalMessages.toLocaleString()} message${totalMessages === 1 ? '' : 's'}`,
    body: 'Engagement is building. Ask visitors to rate their chats to unlock satisfaction and resolution insights.',
    tone: 'accent',
    icon: Sparkles,
  };
}

/**
 * AgentAnalyticsPage — the "How is my AI performing?" tab for a single agent.
 * A headline insight and KPI row answer the question at a glance; the tabbed
 * sections below let owners drill into engagement, questions, leads, and
 * satisfaction without leaving the page.
 */
export function AgentAnalyticsPage(): ReactElement {
  const { agent, loading: agentLoading, error: agentError } = useAgent();
  const state = useAgentAnalytics(agent?.id ?? null);
  const [panel, setPanel] = useState<PanelKey>('engagement');

  const totalMessages = useMemo(
    () => state.data?.engagement.reduce((sum, p) => sum + p.messages, 0) ?? 0,
    [state.data],
  );

  // Agent list still resolving — hold the layout with skeletons.
  if (agentLoading && !agent) {
    return (
      <PageContainer title="Analytics" description="How your AI is performing.">
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-28 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-80 rounded-xl" />
      </PageContainer>
    );
  }

  // Route points at an agent that doesn't exist (or the list failed to load).
  if (!agent) {
    return (
      <PageContainer title="Analytics">
        <EmptyState
          icon={AlertTriangle}
          title={agentError ? 'Couldn’t load this agent' : 'Agent not found'}
          description={
            agentError
              ? 'Something went wrong loading this agent. Please try again.'
              : 'This agent may have been deleted or you don’t have access to it.'
          }
        />
      </PageContainer>
    );
  }

  const { data, loading, error } = state;

  if (error) {
    return (
      <PageContainer title="Analytics" description="How your AI is performing.">
        <EmptyState
          icon={AlertTriangle}
          title="Couldn’t load analytics"
          description={error}
          action={
            <Button variant="outline" onClick={state.reload}>
              Try again
            </Button>
          }
        />
      </PageContainer>
    );
  }

  const analytics = data ?? {
    engagement: [],
    topQuestions: [],
    ratings: { avg: null, total: 0, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } },
    resolution: { resolved: 0, unresolved: 0, total: 0, rate: null },
    leads: null,
  };

  const insight = computeInsight(analytics, totalMessages);

  // "Leads" means captured/qualified leads, not raw conversations. The server's
  // `leads.total` is len(sessions) (every visitor who chatted, incl. tier
  // 'unqualified'), so sum the mutually-exclusive qualified tiers instead — this
  // matches the funnel's "Marketing-qualified" stage in LeadsBreakdown.
  const qualifiedLeads = analytics.leads
    ? analytics.leads.mql + analytics.leads.sal + analytics.leads.sql
    : 0;

  return (
    <PageContainer title="Analytics" description="How your AI is performing.">
      {/* KPI row — the four numbers that summarise agent health. */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard
          icon={MessageSquare}
          label="Messages"
          value={loading ? '—' : totalMessages.toLocaleString()}
        />
        <MetricCard
          icon={Users}
          label="Leads"
          value={loading ? '—' : qualifiedLeads.toLocaleString()}
        />
        <MetricCard
          icon={CheckCircle2}
          label="Resolution rate"
          value={loading || analytics.resolution.rate === null ? '—' : `${analytics.resolution.rate}%`}
        />
        <MetricCard
          icon={Star}
          label="Avg. rating"
          value={loading || analytics.ratings.avg === null ? '—' : `${analytics.ratings.avg} / 5`}
        />
      </div>

      {/* Headline takeaway. */}
      {!loading && (
        <InsightCard title={insight.title} body={insight.body} tone={insight.tone} icon={insight.icon} />
      )}

      {/* Deep-dive sections. */}
      <div>
        <Tabs
          tabs={PANELS}
          value={panel}
          onChange={(key) => {
            if (isPanelKey(key)) setPanel(key);
          }}
          ariaLabel="Analytics sections"
        />
        <div
          id={`tabpanel-${panel}`}
          role="tabpanel"
          aria-labelledby={`tab-${panel}`}
          tabIndex={0}
          className="mt-6 focus-visible:outline-none"
        >
          {panel === 'engagement' && (
            <EngagementChart data={analytics.engagement} loading={loading} />
          )}
          {panel === 'questions' && (
            <TopQuestions questions={analytics.topQuestions} loading={loading} />
          )}
          {panel === 'leads' && <LeadsBreakdown leads={analytics.leads} loading={loading} />}
          {panel === 'satisfaction' && (
            <SatisfactionBreakdown
              ratings={analytics.ratings}
              resolution={analytics.resolution}
              loading={loading}
            />
          )}
        </div>
      </div>
    </PageContainer>
  );
}
