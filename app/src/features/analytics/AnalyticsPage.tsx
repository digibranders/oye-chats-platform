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
  Skeleton,
  Tabs,
  cn,
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
import { LanguageBreakdown, TranslationUsage } from './LanguageBreakdown';
import { FeedbackPanel } from '../feedback/FeedbackPanel';
import { UnansweredQuestionsPanel } from './UnansweredQuestionsPanel';
import { t as translateNow } from '../../i18n/i18n';
import { formatNumber } from '../../i18n/formatters';
import { useTranslation } from '../../i18n/useTranslation';

type AnalyticsTab = 'conversations' | 'leads' | 'satisfaction' | 'language' | 'feedback' | 'uaq';

const TAB_ITEMS: ReadonlyArray<{ key: AnalyticsTab; label: string }> = [
  { key: 'conversations', label: 'Conversations' },
  { key: 'leads', label: 'Leads' },
  { key: 'satisfaction', label: 'Satisfaction' },
  { key: 'feedback', label: 'Feedback' },
  { key: 'uaq', label: 'UAQ' },
];

/**
 * Shown only for an agent with multilingual on. For a single-language chatbot
 * the panel would be one "English 100%" row, which is noise rather than
 * insight, and on the "All agents" scope there is no single language config to
 * report against. Inserted before Feedback, beside the other per-agent views.
 */
const LANGUAGE_TAB: { key: AnalyticsTab; label: string } = { key: 'language', label: 'Languages' };

/**
 * Narrow the Tabs string key back to the AnalyticsTab union without casting.
 *
 * Must cover LANGUAGE_TAB as well as TAB_ITEMS. That tab is rendered from a
 * separate constant because it is conditional, and validating against
 * TAB_ITEMS alone made `onChange` reject its own key, so the tab rendered but
 * could never be selected.
 */
const TAB_KEYS: ReadonlySet<string> = new Set([
  ...TAB_ITEMS.map((item) => item.key),
  LANGUAGE_TAB.key,
]);

function isAnalyticsTab(key: string): key is AnalyticsTab {
  return TAB_KEYS.has(key);
}

/**
 * Map a signed week-over-week percentage change onto a MetricCard trend
 * direction. The delta is labelled with its reference window (`· 7d`) so the
 * headline figure reads as a well-defined period-over-period comparison rather
 * than an unqualified percentage.
 */
function trendFromChange(change: number | null): { delta?: string; trend?: MetricTrend } {
  if (change === null) return {};
  if (change === 0)
    return {
      delta:
        translateNow('analytics.noChangeWindow', { days: MOMENTUM_WINDOW_DAYS }) ||
        `No change · ${MOMENTUM_WINDOW_DAYS}d`,
      trend: 'flat',
    };
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
      title:
        translateNow(
          leads.sql === 1 ? 'analytics.readyToBuyCapturedOne' : 'analytics.readyToBuyCapturedMany',
          { count: formatNumber(leads.sql) },
        ) || `${formatNumber(leads.sql)} ready-to-buy leads captured`,
      body: translateNow('analytics.yourChatbotsAreTurningConversations') || 'Your chatbots are turning conversations into qualified pipeline. Review them in Leads to follow up.',
    };
  }

  return null;
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
  const { t } = useTranslation();
  return (
    <EmptyState
      icon={TriangleAlert}
      title={t('analytics.weCouldntLoadYourAnalytics') || 'We couldn’t load your analytics'}
      description={message}
      action={
        <Button variant="primary" onClick={onRetry}>
          <RefreshCw size={16} aria-hidden="true" />
          {t('analytics.tryAgain') || 'Try again'}
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
  const { t } = useTranslation();
  const { bots, selectedBot, loading: botsLoading } = useBotContext();
  const chatbotName = selectedBot?.name ?? (t('analytics.thisChatbot') || 'this chatbot');
  // When the shell BotSwitcher is set to a specific agent, scope the whole
  // page to that bot; when it's on "All agents" (`selectedBot === null`), fall
  // back to workspace-aggregated across every agent.
  // One period control for the page. It slices the message trend client-side
  // AND scopes the language breakdown server-side, so a customer never has to
  // reconcile two different notions of "last 30 days" on one screen.
  const [range, setRange] = useState<TrendRange>('all');
  const {
    status,
    data,
    error,
    refreshing,
    reload,
    language: languageData,
    languageRefreshing,
  } = useWorkspaceAnalytics(selectedBot?.id ?? null, range);
  const [tab, setTab] = useState<AnalyticsTab>('conversations');
  const { hasFeature } = useEntitlements();
  const { openUpgradeModal } = useUpgradeModal();
  // Leads is BANT-derived (Standard+). Free / Starter see a lock chip on the
  // tab and the panel body swaps to the upgrade card.
  // Satisfaction is CSAT gathered from live-chat post-chat ratings, so it
  // travels with the `live_chat` feature (Starter and up). Only Free is
  // locked here. Starter accumulates real ratings and should see them.
  const leadsUnlocked = hasFeature('bant');
  const satisfactionUnlocked = hasFeature('live_chat');

  // Resolved server-side and delivered with the data, so the tab appears once
  // the page has loaded rather than being guessed at from another source.
  const showLanguage = languageData?.multilingualEnabled === true;

  // Switching the shell's bot switcher to a single-language agent, or to
  // "All agents", removes the Languages tab. The selected-tab state survives
  // that, so without this the strip would show nothing selected above an empty
  // body. Derived rather than corrected in an effect, so there is no flash of
  // the broken state.
  const activeTab: AnalyticsTab = tab === 'language' && !showLanguage ? 'conversations' : tab;

  const tabItems = useMemo(
    () =>
      (showLanguage
        ? [...TAB_ITEMS.slice(0, TAB_ITEMS.length - 1), LANGUAGE_TAB, TAB_ITEMS[TAB_ITEMS.length - 1]]
        : TAB_ITEMS
      ).map((item) => {
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
    [leadsUnlocked, satisfactionUnlocked, showLanguage],
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
        title={t('analytics.analytics') || 'Analytics'}
      >
        <EmptyState
          icon={BarChart3}
          title={t('analytics.noPerformanceDataYet') || 'No performance data yet'}
          description={t('analytics.createYourFirstAiChatbot') || 'Create your first AI chatbot and deploy it to start tracking conversations, leads, and satisfaction here.'}
          action={
            <Link
              to="/agents"
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-[var(--ds-accent)] px-4 text-sm font-medium text-[var(--ds-accent-fg)] shadow-[var(--ds-shadow-sm)] transition-colors hover:bg-[var(--ds-accent-hover)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]"
            >
              <BotIcon size={16} aria-hidden="true" />
              {t('analytics.createAnAiChatbot') || 'Create an AI chatbot'}
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
      title={t('analytics.analytics') || 'Analytics'}
      description={t('analytics.howYourWholeWorkspaceIs') || 'How your whole workspace is performing across every AI chatbot.'}
      actions={actions}
    >
      {showLoading ? (
        <LoadingState />
      ) : status === 'error' || !data ? (
        <ErrorState message={error ?? (t('analytics.somethingWentWrong') || 'Something went wrong.')} onRetry={reload} />
      ) : (
        <>
          {insight && (
            <InsightCard tone={insight.tone} icon={Sparkles} title={insight.title} body={insight.body} />
          )}

          <Tabs
            tabs={tabItems}
            value={activeTab}
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
            ariaLabel={t('analytics.analyticsViews') || 'Analytics views'}
          />

          {/* Conversations */}
          {activeTab === 'conversations' && (
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
                    title={t('analytics.messageVolume') || 'Message volume'}
                    description={t('analytics.dailyMessagesAcrossEveryChatbot') || 'Daily messages across every chatbot'}
                    actions={
                      <SegmentedControl
                        options={TREND_RANGES.map((r) => ({
                          ...r,
                          label: t(`analytics.range.${r.value}`) || r.label,
                        }))}
                        value={range}
                        onChange={setRange}
                        ariaLabel={t('analytics.messageTrendTimeRange') || 'Message trend time range'}
                      />
                    }
                  />
                </CardHeader>
                <CardContent className="pt-0">
                  <div className="mb-4 grid grid-cols-3 gap-3">
                    <MetricCard
                      size="sm"
                      label={t('analytics.messages') || 'Messages'}
                      value={trendSummary.total.toLocaleString()}
                      icon={MessageSquare}
                      delta={messagesTrend.delta}
                      trend={messagesTrend.trend}
                    />
                    <MetricCard
                      size="sm"
                      label={t('analytics.dailyAverage') || 'Daily average'}
                      value={trendSummary.dailyAverage.toLocaleString()}
                      icon={BarChart3}
                    />
                    <MetricCard
                      size="sm"
                      label={t('analytics.busiestDay') || 'Busiest day'}
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
                      title={t('analytics.noMessagesInThisRange') || 'No messages in this range'}
                      description={t('analytics.tryAWiderTimeRange') || 'Try a wider time range, or come back once your chatbots have handled more conversations.'}
                    />
                  ) : (
                    <MessageTrendChart points={trendWindow} />
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <SectionHeader
                    title={t('analytics.topQuestions') || 'Top questions'}
                    description={t('analytics.whatVisitorsAskYourChatbots') || 'What visitors ask your chatbots most'}
                  />
                </CardHeader>
                <CardContent className="pt-0">
                  <TopQuestionsList questions={data.topQuestions} />
                </CardContent>
              </Card>
            </div>
          )}

          {/* Leads */}
          {activeTab === 'leads' && (
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
          {activeTab === 'satisfaction' && (
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
                      title={t('analytics.visitorSatisfaction') || 'Visitor satisfaction'}
                      description={t('analytics.postChatRatingsFromLive') || 'Post-chat ratings from live conversations, across every chatbot'}
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

          {/* Languages. While a period change is in flight the PREVIOUS period's
              numbers are still on screen under the NEW period's label, so the
              panel is dimmed and marked busy rather than reading as final. It
              stays mounted so the panel never flashes to a skeleton. */}
          {activeTab === 'language' && languageData && (
            <div
              role="tabpanel"
              id="tabpanel-language"
              aria-labelledby="tab-language"
              tabIndex={0}
              aria-busy={languageRefreshing}
              className={cn(
                'space-y-6 transition-opacity focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]',
                languageRefreshing && 'opacity-60',
              )}
            >
              <Card>
                <CardHeader>
                  <SectionHeader
                    title={t('analytics.languages') || 'Languages'}
                    description={
                  t('analytics.languageMixDescription', { name: chatbotName }) ||
                  `What visitors chat to ${chatbotName} in, and how each language performs`
                }
                    actions={
                      // The SAME state the message trend uses, rendered here so
                      // the control is reachable from the tab it affects. Not a
                      // second selector: moving it on either tab moves it on both.
                      <SegmentedControl
                        options={TREND_RANGES.map((r) => ({
                          ...r,
                          label: t(`analytics.range.${r.value}`) || r.label,
                        }))}
                        value={range}
                        onChange={setRange}
                        ariaLabel={t('analytics.languageBreakdownTimeRange') || 'Language breakdown time range'}
                      />
                    }
                  />
                </CardHeader>
                <CardContent className="pt-0">
                  <LanguageBreakdown data={languageData} />
                </CardContent>
              </Card>

              {languageData.operatorTranslationEnabled && (
                <Card>
                  <CardHeader>
                    <SectionHeader
                      title={t('analytics.translation') || 'Translation'}
                      description={t('analytics.liveChatTranslatedBetweenYour') || 'Live chat translated between your visitors and your team'}
                    />
                  </CardHeader>
                  <CardContent className="pt-0">
                    <TranslationUsage data={languageData} />
                  </CardContent>
                </Card>
              )}
            </div>
          )}

          {/* Feedback */}
          {activeTab === 'feedback' && (
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

          {/* UAQ (Unanswered Questions) */}
          {tab === 'uaq' && (
            <div
              role="tabpanel"
              id="tabpanel-uaq"
              aria-labelledby="tab-uaq"
              tabIndex={0}
              className="space-y-6 focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]"
            >
              <UnansweredQuestionsPanel botId={selectedBot?.id ?? null} />
            </div>
          )}
        </>
      )}
    </PageContainer>
  );
}
