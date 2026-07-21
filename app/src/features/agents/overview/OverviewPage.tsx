import { type ReactElement, type ReactNode } from 'react';
import {
  AlertCircle,
  BarChart3,
  CheckCircle2,
  MessagesSquare,
  RefreshCw,
  Users,
  type LucideIcon,
} from 'lucide-react';
import {
  Button,
  Card,
  EmptyState,
  PageContainer,
  SectionHeader,
  Skeleton,
} from '../../../design-system';
// MetricCard is a Foundation composite; import it directly (the barrel export is
// wired by the orchestrator) so this file compiles independently.
import { MetricCard } from '../../../design-system/components/MetricCard';
import { useAgent } from '../../../context/AgentContext';
import { type Bot } from '../../../types/domain';
import { deriveAgentHealth } from './agent-health';
import { useOverviewData, type AgentStats } from './overview-data';
import { HealthHero } from './HealthHero';
import { ActivityTrend } from './ActivityTrend';
import { TopQuestions } from './TopQuestions';

interface MetricDef {
  readonly key: keyof AgentStats;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly format: (stats: AgentStats) => ReactNode;
}

/**
 * The four headline metrics. No trend deltas: the dashboard endpoint returns a
 * scalar snapshot (not a per-metric time series), so any arrow here would be
 * fabricated. Trend belongs on the Analytics tab where real history exists.
 */
const METRICS: readonly MetricDef[] = [
  {
    key: 'activeUsers',
    label: 'Active visitors',
    icon: Users,
    format: (s) => s.activeUsers.toLocaleString(),
  },
  {
    key: 'totalConversations',
    label: 'Conversations',
    icon: MessagesSquare,
    format: (s) => s.totalConversations.toLocaleString(),
  },
  {
    key: 'totalMessages',
    label: 'Messages',
    icon: BarChart3,
    format: (s) => s.totalMessages.toLocaleString(),
  },
  {
    key: 'successRate',
    label: 'Helpful answers',
    icon: CheckCircle2,
    format: (s) => `${s.successRate}%`,
  },
];

/** Four-up metric grid; renders skeletons while stats load. */
function MetricGrid({
  stats,
  loading,
}: {
  readonly stats: AgentStats | null;
  readonly loading: boolean;
}): ReactElement {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {METRICS.map((metric) => (
        <MetricCard
          key={metric.key}
          label={metric.label}
          icon={metric.icon}
          value={
            loading || !stats ? (
              <Skeleton className="h-7 w-16" />
            ) : (
              metric.format(stats)
            )
          }
        />
      ))}
    </div>
  );
}

/** Inline, retryable error surface for the metrics fetch. */
function MetricsError({
  message,
  onRetry,
}: {
  readonly message: string;
  readonly onRetry: () => void;
}): ReactElement {
  return (
    <Card className="p-6">
      <EmptyState
        icon={AlertCircle}
        title="Couldn’t load your metrics"
        description={message}
        action={
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RefreshCw size={15} aria-hidden="true" />
            Try again
          </Button>
        }
      />
    </Card>
  );
}

/**
 * OverviewContent — the data-bound body, mounted only once we have a resolved
 * agent. Remounted per agent via `key={agent.id}` in the parent, so the data
 * hook sees a stable id and never resets state synchronously in an effect.
 */
function OverviewContent({ agent }: { readonly agent: Bot }): ReactElement {
  const health = deriveAgentHealth(agent);
  const { status, stats, activity, questions, error, refetch } = useOverviewData(agent.id);
  const agentBasePath = `/agents/${agent.id}`;
  const isLoading = status === 'loading';

  return (
    <PageContainer
      title="Overview"
      description="A quick read on your AI’s health and how visitors are engaging with it."
      actions={
        <Button variant="outline" size="sm" onClick={refetch} disabled={isLoading}>
          <RefreshCw size={15} aria-hidden="true" className={isLoading ? 'animate-spin' : undefined} />
          Refresh
        </Button>
      }
    >
      <HealthHero health={health} agentBasePath={agentBasePath} />

      {status === 'error' && error ? (
        <MetricsError message={error} onRetry={refetch} />
      ) : (
        <MetricGrid stats={stats} loading={isLoading} />
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section className="space-y-4" aria-labelledby="overview-activity-heading">
          <SectionHeader
            title={<span id="overview-activity-heading">Message activity</span>}
            description="Daily conversation volume."
          />
          {isLoading ? (
            <Card className="p-6">
              <Skeleton className="h-40 w-full" />
            </Card>
          ) : (
            <ActivityTrend points={activity} />
          )}
        </section>

        <section className="space-y-4" aria-labelledby="overview-questions-heading">
          <SectionHeader
            title={<span id="overview-questions-heading">Top questions</span>}
            description="What visitors ask your AI most."
          />
          {isLoading ? (
            <Card className="space-y-4 p-6">
              {[0, 1, 2, 3].map((row) => (
                <Skeleton key={row} className="h-9 w-full" />
              ))}
            </Card>
          ) : (
            <TopQuestions questions={questions} />
          )}
        </section>
      </div>
    </PageContainer>
  );
}

/** Skeleton shown while the agent itself is still resolving from context. */
function OverviewSkeleton(): ReactElement {
  return (
    <PageContainer title="Overview">
      <Card className="p-6">
        <div className="flex gap-5">
          <Skeleton className="h-12 w-12 rounded-xl" />
          <div className="flex-1 space-y-3">
            <Skeleton className="h-6 w-52" />
            <Skeleton className="h-4 w-full max-w-md" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        </div>
      </Card>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((cell) => (
          <Card key={cell} className="p-5">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="mt-3 h-7 w-16" />
          </Card>
        ))}
      </div>
    </PageContainer>
  );
}

/**
 * OverviewPage — the AI Agent "Overview" tab. Answers "Is my AI healthy?" with
 * a status verdict up top, headline engagement metrics, and a read on what
 * visitors are doing. Mounted under `/agents/:agentId/overview` inside the
 * agent layout, so it reads the active agent from `useAgent()`.
 */
export function OverviewPage(): ReactElement {
  const { agent, loading, error } = useAgent();

  if (agent) {
    // key: give the data hook a stable, per-agent lifetime.
    return <OverviewContent key={agent.id} agent={agent} />;
  }

  if (loading) {
    return <OverviewSkeleton />;
  }

  return (
    <PageContainer title="Overview">
      <Card className="p-6">
        <EmptyState
          icon={AlertCircle}
          title={error ? 'We couldn’t load this agent' : 'Agent not found'}
          description={
            error
              ? 'Something went wrong loading this agent. Please refresh the page.'
              : 'This agent doesn’t exist or you don’t have access to it.'
          }
        />
      </Card>
    </PageContainer>
  );
}
