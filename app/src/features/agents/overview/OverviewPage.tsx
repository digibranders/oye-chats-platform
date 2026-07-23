import { type ReactElement, type ReactNode } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  MessagesSquare,
  RefreshCw,
  Star,
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
import { MetricCard } from '../../../design-system/components/MetricCard';
import { useAgent } from '../../../context/AgentContext';
import { type Bot } from '../../../types/domain';
import { deriveAgentHealth } from './agent-health';
import { useOverviewData, type AgentStats } from './overview-data';
import { AgentOverviewHero } from './AgentOverviewHero';
import { HealthHero } from './HealthHero';
import { AgentSnapshotCards } from './AgentSnapshotCards';
import { TopQuestions } from './TopQuestions';

interface MetricDef {
  readonly key: keyof AgentStats;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly format: (stats: AgentStats) => ReactNode;
}

/**
 * The four headline Mission Control metrics.
 * Replaces total messages with resolution rate and average rating for honest quality read.
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
    key: 'resolutionRate',
    label: 'Resolution rate',
    icon: CheckCircle2,
    format: (s) => (s.resolutionRate === null || s.resolutionRate === undefined ? '—' : `${s.resolutionRate}%`),
  },
  {
    key: 'averageRating',
    label: 'Average rating',
    icon: Star,
    format: (s) => (s.averageRating === null || s.averageRating === undefined ? '—' : `${s.averageRating} / 5`),
  },
];

/** Four-up grid of headline metrics. */
function MetricGrid({ stats }: { readonly stats: AgentStats }): ReactElement {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {METRICS.map((metric) => (
        <MetricCard
          key={metric.key}
          label={metric.label}
          icon={metric.icon}
          value={metric.format(stats)}
        />
      ))}
    </div>
  );
}

/** Placeholder tiles shown during the first metrics load. */
function MetricGridSkeleton(): ReactElement {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {METRICS.map((metric) => (
        <Card key={metric.key} className="p-5">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="mt-3 h-7 w-16" />
        </Card>
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

/** Neutral placeholder for a section whose data failed to load. */
function SectionUnavailable(): ReactElement {
  return (
    <Card className="p-6">
      <EmptyState
        icon={AlertCircle}
        title="Couldn’t load this section"
        description="Refresh to try loading this data again."
      />
    </Card>
  );
}

/**
 * OverviewContent — Mission Control layout for an agent.
 */
function OverviewContent({ agent }: { readonly agent: Bot }): ReactElement {
  const health = deriveAgentHealth(agent);
  const { status, isRefetching, stats, activity, questions, details, error, refetch } =
    useOverviewData(agent.id);
  const agentBasePath = `/agents/${agent.id}`;
  const isInitialLoading = status === 'loading';
  const isBusy = isInitialLoading || isRefetching;

  return (
    <PageContainer
      title="Overview"
      description="Mission Control dashboard for your AI agent health, knowledge, channels, and performance."
      actions={
        <Button variant="outline" size="sm" onClick={refetch} disabled={isBusy}>
          <RefreshCw
            size={15}
            aria-hidden="true"
            className={isBusy ? 'animate-spin' : undefined}
          />
          Refresh
        </Button>
      }
    >
      <AgentOverviewHero agent={agent} health={health} agentBasePath={agentBasePath} />

      <HealthHero health={health} agentBasePath={agentBasePath} />

      {status === 'error' && error ? (
        <MetricsError message={error} onRetry={refetch} />
      ) : stats ? (
        <MetricGrid stats={stats} />
      ) : (
        <MetricGridSkeleton />
      )}

      <AgentSnapshotCards
        agent={agent}
        details={details}
        stats={stats}
        activity={activity}
        agentBasePath={agentBasePath}
      />

      <section className="space-y-4" aria-labelledby="overview-questions-heading">
        <SectionHeader
          title={<span id="overview-questions-heading">Top questions</span>}
          description="What visitors ask your AI most."
        />
        {isInitialLoading ? (
          <Card className="space-y-4 p-6">
            {[0, 1, 2, 3].map((row) => (
              <Skeleton key={row} className="h-9 w-full" />
            ))}
          </Card>
        ) : status === 'error' ? (
          <SectionUnavailable />
        ) : (
          <TopQuestions questions={questions} />
        )}
      </section>
    </PageContainer>
  );
}

/** Skeleton shown while the agent itself is resolving from context. */
function OverviewSkeleton(): ReactElement {
  return (
    <PageContainer title="Overview">
      <Card className="p-6">
        <div className="flex gap-5">
          <Skeleton className="h-14 w-14 rounded-2xl" />
          <div className="flex-1 space-y-3">
            <Skeleton className="h-6 w-52" />
            <Skeleton className="h-4 w-full max-w-md" />
          </div>
        </div>
      </Card>
      <Card className="p-6">
        <div className="space-y-3">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-full" />
        </div>
      </Card>
      <MetricGridSkeleton />
    </PageContainer>
  );
}

export function OverviewPage(): ReactElement {
  const { agent, loading, error } = useAgent();

  if (agent) {
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
