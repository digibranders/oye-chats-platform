import { type ReactElement } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity as ActivityIcon,
  AlertTriangle,
  ArrowRight,
  BarChart3,
  CheckCircle2,
  Inbox,
  MessageSquare,
  Plus,
  Radio,
  RefreshCw,
  Sparkles,
  Target,
  ThumbsDown,
  ThumbsUp,
  Users,
  type LucideIcon,
} from 'lucide-react';
import {
  Button,
  Card,
  EmptyState,
  LockedFeatureCard,
  PageContainer,
  PlanBadge,
  QuotaMeter,
  SectionHeader,
  Skeleton,
} from '../../design-system';
import { MetricCard } from '../../design-system/components/MetricCard';
import { InsightCard, type InsightCardProps } from '../../design-system/components/InsightCard';
import { ActionCard, type ActionCardProps } from '../../design-system/components/ActionCard';
import { AgentCard } from '../../design-system/components/AgentCard';
import { ActivityTimeline, type ActivityItem } from '../../design-system/components/ActivityTimeline';
import { DataTable, type Column } from '../../design-system/components/DataTable';
import { QuickAction } from '../../design-system/components/QuickAction';
import { useEntitlements } from '../../hooks/useEntitlements';
import type { Bot, TopQuestion } from '../../types/domain';
import {
  firstName,
  formatRelativeTime,
  formatToday,
  greeting,
  type ActivityEntry,
  type ActivityKind,
  type HomeData,
} from './home-data';
import { useHomeData } from './useHomeData';
import { useBotContext } from '../../context/BotContext';
import { getAuthItem } from '../../utils/authStorage';
import { getImpersonationProfile } from '../../utils/impersonation';

// ── Small presentation helpers ───────────────────────────────────────────────

function formatCount(value: number): string {
  return Math.round(value).toLocaleString('en-US');
}

function formatPercent(value: number): string {
  const clamped = Math.max(0, Math.min(100, value));
  return `${Math.round(clamped)}%`;
}

const ACTIVITY_VISUALS: Record<ActivityKind, { icon: LucideIcon; tone: ActivityItem['tone'] }> = {
  'positive-feedback': { icon: ThumbsUp, tone: 'success' },
  'negative-feedback': { icon: ThumbsDown, tone: 'danger' },
  message: { icon: Inbox, tone: 'info' },
};

function toActivityItems(entries: ActivityEntry[]): ActivityItem[] {
  return entries.map((entry) => {
    const visual = ACTIVITY_VISUALS[entry.kind];
    return {
      id: entry.id,
      icon: visual.icon,
      tone: visual.tone,
      title: entry.title,
      meta: entry.meta ?? undefined,
      time: formatRelativeTime(entry.iso),
    };
  });
}

interface Recommendation extends Pick<ActionCardProps, 'title' | 'description' | 'icon' | 'cta'> {
  key: string;
  to: string;
}

/**
 * Build up to three "next best action" cards from the current state. Priority:
 * unblock broken agents → train → deploy → work leads/inbox → grow. There is
 * always at least one, so the section never renders empty.
 */
function buildRecommendations(data: HomeData, agentScoped: boolean): Recommendation[] {
  const recs: Recommendation[] = [];

  // Follow up on hot leads - the primary operational nudge, shown when any exist.
  if (agentScoped && data.totals.hotLeads > 0) {
    recs.push({
      key: 'leads',
      icon: Target,
      title: `Follow up on ${formatCount(data.totals.hotLeads)} hot lead${data.totals.hotLeads === 1 ? '' : 's'}`,
      description: 'High-intent visitors are waiting. Review and reach out while they’re warm.',
      to: '/leads',
      cta: 'View leads',
    });
  }

  return recs;
}

/** Headline observation for the aside, derived from workspace health. */
function buildHealthInsight(data: HomeData): {
  title: string;
  body: string;
  tone: InsightCardProps['tone'];
  icon: LucideIcon;
} {
  const readyToDeploy = data.agents.filter((agent) => agent.trained && !agent.installed).length;

  if (readyToDeploy > 0) {
    return {
      icon: Radio,
      tone: 'info',
      title: `${readyToDeploy} chatbot${readyToDeploy === 1 ? ' is' : 's are'} ready to go live`,
      body: 'Add the widget to your website to start capturing real conversations.',
    };
  }
  if (data.totals.conversations === 0) {
    return {
      icon: Sparkles,
      tone: 'accent',
      title: 'Your chatbots are ready',
      body: 'Share a test link or add the widget to your site to see your first conversations.',
    };
  }
  return {
    icon: CheckCircle2,
    tone: 'success',
    title: 'Everything looks healthy',
    body: 'Your chatbots are live and answering questions. Keep an eye on the metrics below.',
  };
}

// ── Loading / error / empty scaffolds ────────────────────────────────────────

function HomeSkeleton(): ReactElement {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading your dashboard…</span>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Card key={i} className="p-5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-4 h-7 w-20" />
          </Card>
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Skeleton className="h-4 w-32" />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {[0, 1].map((i) => (
              <Card key={i} className="p-5">
                <Skeleton className="h-9 w-9 rounded-lg" />
                <Skeleton className="mt-3 h-4 w-28" />
                <Skeleton className="mt-4 h-10 w-full" />
              </Card>
            ))}
          </div>
        </div>
        <div className="space-y-4">
          <Skeleton className="h-4 w-40" />
          <Card className="p-5">
            <Skeleton className="h-24 w-full" />
          </Card>
        </div>
      </div>
    </div>
  );
}

interface HomeErrorProps {
  message: string;
  onRetry: () => void;
}

function HomeError({ message, onRetry }: HomeErrorProps): ReactElement {
  return (
    <EmptyState
      icon={AlertTriangle}
      title="We couldn’t load your dashboard"
      description={message}
      action={
        <Button variant="outline" onClick={onRetry}>
          <RefreshCw size={15} aria-hidden="true" />
          Try again
        </Button>
      }
    />
  );
}

function HomeEmpty(): ReactElement {
  return (
    <EmptyState
      icon={Sparkles}
      title="Create your first AI chatbot"
      description="Set up a chatbot, train it on your content and add it to your website. We’ll guide you through every step."
      action={
        <Link
          to="/launch"
          className="inline-flex h-9 items-center gap-2 rounded-lg bg-[var(--ds-accent)] px-4 text-sm font-medium text-[var(--ds-accent-fg)] shadow-[var(--ds-shadow-sm)] transition-colors hover:bg-[var(--ds-accent-hover)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]"
        >
          <Plus size={15} aria-hidden="true" />
          Get started
        </Link>
      }
    />
  );
}

/**
 * PlanUsageCard - a compact plan-and-capacity glance for a single agent: the
 * workspace's plan badge plus usage-populated limit meters (see `useEntitlements`
 * foundation notes; `credits`, `page_scraping`, `chat_history_days` are NOT
 * populated by the backend `usage` map, so they're deliberately left off this
 * summary rather than shown with a fabricated "used" count). Free workspaces get
 * a subtle upgrade nudge into Workspace ▸ Billing.
 *
 * Always agent-scoped: Members (operator seats are per-bot) and Documents are
 * scoped to `selectedBot`, matching the rest of Home and the per-bot seat model
 * on the Members page. The card is only mounted when an agent is selected — on
 * "All agents" the account-wide meters read as unactionable over-limit red bars,
 * so Home hides it and plan capacity lives in Workspace ▸ Billing instead.
 */
function PlanUsageCard({
  selectedBot,
  data,
}: {
  selectedBot: Bot;
  data: HomeData;
}): ReactElement {
  const { isFree, planName, limitFor } = useEntitlements();

  // Pull this agent's per-bot counts from the loaded roster; fall back to 0s if
  // the roster row isn't present yet.
  const agent = data.agents.find((a) => a.bot.id === selectedBot.id) ?? null;
  const membersUsed = agent?.operators ?? 0;
  const documentsUsed = agent?.documents ?? 0;

  return (
    <Card className="space-y-5 p-5">
      <SectionHeader
        title="Plan & usage"
        description={`Usage for ${selectedBot.name}`}
        actions={<PlanBadge planName={planName} />}
      />

      <div className="space-y-4">
        <QuotaMeter label="Members" used={membersUsed} limit={limitFor('operators')} />
        <QuotaMeter label="Documents" used={documentsUsed} limit={limitFor('documents')} />
      </div>

      {isFree && (
        <Link
          to="/workspace/billing"
          className="flex items-center justify-between gap-2 rounded-lg border border-[var(--ds-accent)] bg-[var(--ds-accent-soft)] px-3.5 py-2.5 text-[13px] font-medium text-[var(--ds-accent-text)] transition-colors hover:bg-[var(--ds-accent-soft)]/80"
        >
          <span>You&rsquo;re on the Free plan - upgrade for more capacity</span>
          <ArrowRight size={14} aria-hidden="true" className="shrink-0" />
        </Link>
      )}
    </Card>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

const TOP_QUESTION_COLUMNS: Column<TopQuestion>[] = [
  {
    key: 'question',
    header: 'Question',
    render: (row) => <span className="text-[var(--ds-text)]">{row.question}</span>,
  },
  {
    key: 'count',
    header: 'Times asked',
    align: 'right',
    width: '8rem',
    render: (row) => (
      <span className="font-semibold text-[var(--ds-text)]">{formatCount(row.count)}</span>
    ),
  },
];

/**
 * HomePage - the workspace's daily operational overview. Answers "How is my
 * business doing today?" across every agent: headline KPIs, agent health, the
 * questions visitors ask most, recommended next steps, and a live activity feed.
 */
export function HomePage(): ReactElement {
  // Home mirrors the shell BotSwitcher: a specific agent narrows the whole
  // dashboard to that bot; "All agents" (null) keeps the workspace-wide
  // aggregate that this page has historically shown.
  const { selectedBot } = useBotContext();
  const { data, loading, error, reload } = useHomeData(selectedBot?.id ?? null);

  const now = new Date();
  // A first-person salutation with a wave addresses the HUMAN, not the company.
  // This used to render `currentWorkspaceName` (i.e. `company_name`), greeting
  // "Gaurav" as "Good afternoon, Fynix 👋".
  //
  // Fallback chain: impersonated account's name → `admin_name` (written at
  // login/register/OAuth; there is no in-app rename, so it cannot go stale) →
  // no name at all. It deliberately never falls back to the workspace name.
  // The impersonation profile comes first so a super-admin in a support session
  // sees the account holder's name rather than their own.
  const personName = getImpersonationProfile()?.name ?? getAuthItem('admin_name');
  const greetingName = firstName(personName);
  const nameLabel = greetingName ? `, ${greetingName}` : '';
  const headerActions = (
    <div className="hidden items-center gap-2 sm:flex">
      <QuickAction icon={BarChart3} label="Analytics" to="/analytics" />
      <QuickAction icon={Plus} label="New chatbot" to="/agents" />
    </div>
  );

  return (
    <PageContainer
      title={
        <>
          {greeting(now)}
          {nameLabel}
          <span
            className="ml-2 inline-block origin-[70%_70%] hover:animate-wave"
            role="img"
            aria-label="waving hand"
          >
            👋
          </span>
        </>
      }
      description={`${formatToday(now)} · Here’s how your workspace is doing today.`}
      actions={headerActions}
      width="wide"
    >
      {loading ? (
        <HomeSkeleton />
      ) : error ? (
        <HomeError message={error} onRetry={reload} />
      ) : !data || data.agents.length === 0 ? (
        <HomeEmpty />
      ) : (
        <HomeContent data={data} selectedBot={selectedBot} />
      )}
    </PageContainer>
  );
}

function HomeContent({
  data,
  selectedBot,
}: {
  data: HomeData;
  selectedBot: Bot | null;
}): ReactElement {
  const insight = buildHealthInsight(data);
  const recommendations = buildRecommendations(data, selectedBot != null);
  const activityItems = toActivityItems(data.activity);
  const { hasFeature } = useEntitlements();

  return (
    <div className="space-y-8">
      {/* KPI row - scalar snapshots. No trend deltas: the API returns point-in-
          time totals, so a trend arrow here would be fabricated. */}
      <section aria-label="Key metrics">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            label="Conversations"
            value={formatCount(data.totals.conversations)}
            icon={MessageSquare}
          />
          <MetricCard label="Messages" value={formatCount(data.totals.messages)} icon={BarChart3} />
          <MetricCard
            label="Qualified leads"
            value={formatCount(data.totals.leads)}
            icon={Users}
          />
          <MetricCard
            label="Answer success rate"
            value={formatPercent(data.totals.successRate)}
            icon={CheckCircle2}
          />
        </div>
      </section>

      <div className="grid gap-8 lg:grid-cols-3">
        {/* Main column - agents + what people ask */}
        <div className="space-y-8 lg:col-span-2">
          <section aria-label="Your chatbots" className="space-y-4">
            <SectionHeader
              title="Your chatbots"
              description="Health and activity across every AI chatbot in this workspace."
              actions={
                <Link
                  to="/agents"
                  className="text-[13px] font-medium text-[var(--ds-accent-text)] hover:underline"
                >
                  View all
                </Link>
              }
            />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {data.agents.map((agent) => (
                <AgentCard
                  key={agent.bot.id}
                  name={agent.bot.name}
                  avatar={agent.bot.bot_logo ?? undefined}
                  status={{ label: agent.health.label, tone: agent.health.tone }}
                  to={`/agents/${agent.bot.id}/overview`}
                  metrics={[
                    { label: 'Conversations', value: formatCount(agent.conversations) },
                    { label: 'Leads', value: formatCount(agent.leads) },
                  ]}
                />
              ))}
            </div>
          </section>

          <section aria-label="Most asked questions" className="space-y-4">
            <SectionHeader
              title="What visitors ask most"
              description="The questions your chatbots hear the most, across all conversations."
            />
            <DataTable
              columns={TOP_QUESTION_COLUMNS}
              rows={data.topQuestions}
              rowKey={(row) => row.question}
              caption="Most frequently asked questions and how many times each was asked"
              empty={
                <span className="text-[13px] text-[var(--ds-text-muted)]">
                  No questions yet - they’ll appear here once visitors start chatting.
                </span>
              }
            />
          </section>
        </div>

        {/* Aside - plan usage, health insight, next steps, live activity */}
        <div className="space-y-8">
          {/* Plan & usage is scoped to a single agent. On "All agents"
              (selectedBot null) it's hidden: the account-wide Agents/Members
              meters read as over-limit red bars that alarm without being
              actionable here — plan capacity lives in Workspace ▸ Billing. */}
          {selectedBot && (
            <section aria-label="Plan and usage">
              <PlanUsageCard selectedBot={selectedBot} data={data} />
            </section>
          )}

          {!hasFeature('bant') && (
            <section aria-label="Lead qualification">
              <LockedFeatureCard intent="view_qualification" icon={Target} />
            </section>
          )}

          <section aria-label="Recommended next steps" className="space-y-4">
            <InsightCard
              icon={insight.icon}
              tone={insight.tone}
              title={insight.title}
              body={insight.body}
            />
            <div className="space-y-3">
              {recommendations.map((rec) => (
                <ActionCard
                  key={rec.key}
                  icon={rec.icon}
                  title={rec.title}
                  description={rec.description}
                  cta={rec.cta}
                  to={rec.to}
                />
              ))}
            </div>
          </section>

          {/* Recent activity is agent-scoped. On "All agents" it aggregates
              cross-agent feedback/messages that read as noise here, so Home
              hides it — it returns when a single agent is selected. */}
          {selectedBot && (
            <section aria-label="Recent activity" className="space-y-4">
              <SectionHeader title="Recent activity" description="Feedback and new messages." />
              {activityItems.length > 0 ? (
                <Card className="p-5">
                  <ActivityTimeline items={activityItems} />
                </Card>
              ) : (
                <Card className="flex items-center gap-3 p-5">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--ds-bg-sunken)] text-[var(--ds-text-subtle)]">
                    <ActivityIcon size={15} aria-hidden="true" />
                  </span>
                  <p className="text-[13px] text-[var(--ds-text-muted)]">
                    No activity yet. Feedback and visitor messages will show up here.
                  </p>
                </Card>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
