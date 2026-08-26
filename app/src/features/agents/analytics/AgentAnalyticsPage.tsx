import { useMemo, useState, type ReactElement } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Lock,
  MessageSquare,
  Rocket,
  Sparkles,
  Star,
  ThumbsUp,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { Button, EmptyState, LockedFeatureCard, PageContainer, Skeleton } from '../../../design-system';
import { MetricCard } from '../../../design-system/components/MetricCard';
import { InsightCard, type InsightTone } from '../../../design-system/components/InsightCard';
import { Tabs, type TabItem } from '../../../design-system/components/Tabs';
import { useAgent } from '../../../context/AgentContext';
import { useEntitlements } from '../../../hooks/useEntitlements';
import { useUpgradeModal } from '../../../context/UpgradeModalContext';
import { useAgentAnalytics, type AgentAnalytics } from './useAgentAnalytics';
import { EngagementChart } from './EngagementChart';
import { TopQuestions } from './TopQuestions';
import { LeadsBreakdown } from './LeadsBreakdown';
import { SatisfactionBreakdown } from './SatisfactionBreakdown';
import { FeedbackPanel } from '../../feedback/FeedbackPanel';
import { useTranslation } from '../../../i18n/useTranslation';
import { t as translateNow } from '../../../i18n/i18n';
import { formatNumber } from '../../../i18n/formatters';

type PanelKey = 'engagement' | 'questions' | 'leads' | 'satisfaction' | 'feedback';

// @i18n-exempt: resolved at the render site from the panel key
// (`agents.panel.<key>`); the English here is that lookup's fallback.
const PANELS: readonly TabItem[] = [
  { key: 'engagement', label: 'Engagement' },
  { key: 'questions', label: 'Questions' },
  { key: 'leads', label: 'Leads' },
  { key: 'satisfaction', label: 'Satisfaction' },
  { key: 'feedback', label: 'Feedback' },
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

/**
 * Count labels for the insight sentences.
 *
 * English pluralises by appending "s" and the markup used to do that inline.
 * Hindi does not, so each has a singular and a plural key.
 */
function ratedChatsLabel(n: number): string {
  const count = formatNumber(n);
  return (
    translateNow(n === 1 ? 'agents.ratedChatOne' : 'agents.ratedChatMany', { count }) ||
    `${count} rated chat${n === 1 ? '' : 's'}`
  );
}

function responseCountLabel(n: number): string {
  const count = formatNumber(n);
  return (
    translateNow(n === 1 ? 'agents.responseOne' : 'agents.responseMany', { count }) ||
    `${count} response${n === 1 ? '' : 's'}`
  );
}

function messageCountLabel(n: number): string {
  const count = formatNumber(n);
  return (
    translateNow(n === 1 ? 'agents.messageOne' : 'agents.messageMany', { count }) ||
    `${count} message${n === 1 ? '' : 's'}`
  );
}

/**
 * Not a component, so a hook is illegal here: every lookup uses the stable
 * module-level function, which resolves at call time. The sentences that carry
 * a figure are one key each with the count as a parameter - assembling them
 * from fragments only ever read as English - and the plural is its own key.
 */
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
      title: translateNow('agents.noConversationsYet') || 'No conversations yet',
      body: translateNow('agents.onceYourChatbotIsDeployed') || 'Once your chatbot is deployed and visitors start chatting, performance insights will appear here automatically.',
      tone: 'info',
      icon: Rocket,
    };
  }

  if (ratings.total > 0 && ratings.avg !== null) {
    const strong = ratings.avg >= 4;
    const ratedChats = ratedChatsLabel(ratings.total);
    return {
      title:
        translateNow('agents.insightRating', { score: formatNumber(ratings.avg) }) ||
        `Visitors rate this chatbot ${formatNumber(ratings.avg)} out of 5`,
      body: strong
        ? translateNow('agents.insightRatingStrong', { chats: ratedChats }) ||
          `Across ${ratedChats}, satisfaction is strong. Keep your knowledge fresh to hold the score.`
        : translateNow('agents.insightRatingWeak', { chats: ratedChats }) ||
          `Across ${ratedChats}, there's room to improve. Review low-rated chats and fill knowledge gaps.`,
      tone: strong ? 'success' : 'warning',
      icon: strong ? ThumbsUp : Star,
    };
  }

  if (resolution.total > 0 && resolution.rate !== null) {
    const responses = responseCountLabel(resolution.total);
    return {
      title:
        translateNow('agents.insightResolution', { rate: formatNumber(resolution.rate) }) ||
        `${formatNumber(resolution.rate)}% of answered chats were resolved`,
      body:
        translateNow('agents.insightResolutionBody', { responses }) ||
        `Based on ${responses}. Unresolved chats are the fastest place to improve your AI.`,
      tone: resolution.rate >= 70 ? 'success' : 'warning',
      icon: CheckCircle2,
    };
  }

  return {
    title:
      translateNow('agents.insightMessages', { messages: messageCountLabel(totalMessages) }) ||
      `Your AI has handled ${messageCountLabel(totalMessages)}`,
    body: translateNow('agents.engagementIsBuildingAskVisitors') || 'Engagement is building. Ask visitors to rate their chats to unlock satisfaction and resolution insights.',
    tone: 'accent',
    icon: Sparkles,
  };
}

/**
 * AgentAnalyticsPage - the "How is my AI performing?" tab for a single agent.
 * A headline insight and KPI row answer the question at a glance; the tabbed
 * sections below let owners drill into engagement, questions, leads, and
 * satisfaction without leaving the page.
 */
export function AgentAnalyticsPage(): ReactElement {
  const { t } = useTranslation();
  const { agent, agentId, loading: agentLoading, error: agentError } = useAgent();
  const state = useAgentAnalytics(agent?.id ?? null);
  const [panel, setPanel] = useState<PanelKey>('engagement');
  const { hasFeature } = useEntitlements();
  const { openUpgradeModal } = useUpgradeModal();
  // "Leads" reads BANT-derived pipeline stages. Standard+ only. Free / Starter
  // see a locked chip on the tab and the panel body swaps to the upgrade teaser.
  // "Satisfaction" reads CSAT + resolution from live-chat post-chat ratings, so
  // it travels with `live_chat` (Starter and up). Only Free is locked here.
  // Starter accumulates real ratings and should see them.
  const leadsUnlocked = hasFeature('bant');
  const satisfactionUnlocked = hasFeature('live_chat');

  const panels = useMemo<readonly TabItem[]>(
    () =>
      PANELS.map((raw) => {
        const tab = { ...raw, label: translateNow(`agents.panel.${raw.key}`) || raw.label };
        const locked =
          (tab.key === 'leads' && !leadsUnlocked) ||
          (tab.key === 'satisfaction' && !satisfactionUnlocked);
        if (!locked) return tab;
        return {
          ...tab,
          label: (
            <span className="inline-flex items-center gap-1.5">
              <Lock
                size={11}
                strokeWidth={1.75}
                aria-hidden="true"
                className="text-[var(--ds-text-subtle)]"
              />
              {tab.label}
            </span>
          ),
        };
      }),
    [leadsUnlocked, satisfactionUnlocked],
  );

  const totalMessages = useMemo(
    () => state.data?.engagement.reduce((sum, p) => sum + p.messages, 0) ?? 0,
    [state.data],
  );

  // Agent list still resolving - hold the layout with skeletons.
  if (agentLoading && !agent) {
    return (
      <PageContainer title={t('agents.analytics') || 'Analytics'} description={t('agents.howYourAiIsPerforming') || 'How your AI is performing.'}>
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
      <PageContainer title={t('agents.analytics') || 'Analytics'}>
        <EmptyState
          icon={AlertTriangle}
          title={agentError ? t('agents.couldntLoadThisChatbot') || 'Couldn’t load this chatbot' : t('agents.chatbotNotFound') || 'Chatbot not found'}
          description={
            agentError
              ? t('agents.loadFailedTryAgain') || 'Something went wrong loading this chatbot. Please try again.'
              : t('agents.thisChatbotMayHaveBeen') || 'This chatbot may have been deleted or you don’t have access to it.'
          }
        />
      </PageContainer>
    );
  }

  const { data, loading, error } = state;

  if (error) {
    return (
      <PageContainer title={t('agents.analytics') || 'Analytics'} description={t('agents.howYourAiIsPerforming') || 'How your AI is performing.'}>
        <EmptyState
          icon={AlertTriangle}
          title={t('agents.couldntLoadAnalytics') || 'Couldn’t load analytics'}
          description={error}
          action={
            <Button variant="outline" onClick={state.reload}>
              {t('agents.tryAgain') || 'Try again'}
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
  // 'unqualified'), so sum the mutually-exclusive qualified tiers instead - this
  // matches the funnel's "Marketing-qualified" stage in LeadsBreakdown.
  const qualifiedLeads = analytics.leads
    ? analytics.leads.mql + analytics.leads.sal + analytics.leads.sql
    : 0;

  return (
    <PageContainer title={t('agents.analytics') || 'Analytics'} description={t('agents.howYourAiIsPerforming') || 'How your AI is performing.'}>
      {/* KPI row - the four numbers that summarise agent health. */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard
          icon={MessageSquare}
          label={t('agents.messages') || 'Messages'}
          value={loading ? '-' : formatNumber(totalMessages)}
        />
        <MetricCard
          icon={Users}
          label={t('agents.leads') || 'Leads'}
          value={loading ? '-' : formatNumber(qualifiedLeads)}
        />
        <MetricCard
          icon={CheckCircle2}
          label={t('agents.resolutionRate') || 'Resolution rate'}
          value={loading || analytics.resolution.rate === null ? '-' : `${analytics.resolution.rate}%`}
        />
        <MetricCard
          icon={Star}
          label={t('agents.avgRating') || 'Avg. rating'}
          value={loading || analytics.ratings.avg === null ? '-' : `${analytics.ratings.avg} / 5`}
        />
      </div>

      {/* Headline takeaway. */}
      {!loading && (
        <InsightCard title={insight.title} body={insight.body} tone={insight.tone} icon={insight.icon} />
      )}

      {/* Deep-dive sections. */}
      <div>
        <Tabs
          tabs={panels}
          value={panel}
          onChange={(key) => {
            if (!isPanelKey(key)) return;
            if (key === 'leads' && !leadsUnlocked) {
              openUpgradeModal('view_qualification');
              return;
            }
            if (key === 'satisfaction' && !satisfactionUnlocked) {
              openUpgradeModal('view_qualification');
              return;
            }
            setPanel(key);
          }}
          ariaLabel={t('agents.analyticsSections') || 'Analytics sections'}
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
          {panel === 'leads' &&
            (leadsUnlocked ? (
              <LeadsBreakdown leads={analytics.leads} loading={loading} />
            ) : (
              <LockedFeatureCard intent="view_qualification" />
            ))}
          {panel === 'satisfaction' &&
            (satisfactionUnlocked ? (
              <SatisfactionBreakdown
                ratings={analytics.ratings}
                resolution={analytics.resolution}
                loading={loading}
              />
            ) : (
              <LockedFeatureCard intent="view_qualification" />
            ))}
          {panel === 'feedback' && <FeedbackPanel agentId={agentId ?? undefined} />}
        </div>
      </div>
    </PageContainer>
  );
}
