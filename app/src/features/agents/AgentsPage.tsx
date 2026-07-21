import { useCallback, useState, type ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Bot as BotIcon,
  Plus,
  Radio,
  Sparkles,
  AlertTriangle,
  AlertCircle,
  RefreshCw,
} from 'lucide-react';
import {
  Button,
  Card,
  EmptyState,
  PageContainer,
  SectionHeader,
  Skeleton,
} from '../../design-system';
import { MetricCard } from '../../design-system/components/MetricCard';
import { AgentCard } from '../../design-system/components/AgentCard';
import { useBotContext } from '../../context/BotContext';
import { type Bot } from '../../types/domain';
import { getAgentMetrics, getAgentStatus, summarizeAgents } from './agent-status';
import { CreateAgentDialog } from './CreateAgentDialog';
import { AgentActionsMenu } from './AgentActionsMenu';

/**
 * One agent in the grid: the shared, fully-navigational <AgentCard> tile with
 * the actions "⋯" menu overlaid in its top-right corner. The menu is a sibling
 * of the card's link (not a child), so both stay independent, accessible
 * controls — clicking the tile opens the agent, the menu handles the rest.
 */
function AgentGridCard({ bot, onChanged }: { bot: Bot; onChanged: () => void }): ReactElement {
  const { status } = getAgentStatus(bot);
  return (
    <div className="relative">
      <AgentCard
        name={bot.name}
        status={status}
        metrics={getAgentMetrics(bot)}
        avatar={bot.bot_logo ?? undefined}
        to={`/agents/${bot.id}/overview`}
      />
      <div className="absolute right-3 top-3">
        <AgentActionsMenu bot={bot} onChanged={onChanged} />
      </div>
    </div>
  );
}

/** The portfolio summary row — four honest counts derived from the agent list. */
function AgentsSummary({ bots }: { bots: Bot[] }): ReactElement {
  const summary = summarizeAgents(bots);
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <MetricCard label="Total agents" value={summary.total} icon={BotIcon} />
      <MetricCard label="Live" value={summary.live} icon={Radio} />
      <MetricCard label="Training" value={summary.training} icon={Sparkles} />
      <MetricCard label="Needs setup" value={summary.needsSetup} icon={AlertTriangle} />
    </div>
  );
}

/** Placeholder grid shown while the agent list is loading. */
function AgentsLoading(): ReactElement {
  return (
    <div className="space-y-6" aria-hidden="true">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-[92px] rounded-xl" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }).map((_, index) => (
          <Skeleton key={index} className="h-[132px] rounded-xl" />
        ))}
      </div>
    </div>
  );
}

/**
 * AgentsPage — the AI Agents list. Answers exactly one question: "Which agents
 * do I have?"
 *
 * A summary of portfolio health, then a grid of agent tiles that each navigate
 * to the agent's Overview. Data comes from the reused BotContext (an AI Agent
 * IS a legacy Bot), so `loading`/`error` are read straight from the provider —
 * no local fetch state, no synchronous setState in an effect. Creating an agent
 * reuses the legacy `createBot` API via the CreateAgentDialog.
 */
export function AgentsPage(): ReactElement {
  const { bots, loading, error, refreshBots } = useBotContext();
  const [createOpen, setCreateOpen] = useState(false);
  const navigate = useNavigate();

  const handleCreated = useCallback(
    async (bot: Bot): Promise<void> => {
      setCreateOpen(false);
      // Refresh first so the destination Overview resolves the new agent from
      // BotContext instead of briefly rendering "agent not found".
      await refreshBots();
      navigate(`/agents/${bot.id}/overview`);
    },
    [refreshBots, navigate],
  );

  const handleChanged = useCallback((): void => {
    void refreshBots();
  }, [refreshBots]);

  const hasAgents = bots.length > 0;

  return (
    <PageContainer
      title="AI Agents"
      description="Every AI agent in your workspace, and how healthy each one is."
      actions={
        <Button onClick={() => setCreateOpen(true)}>
          <Plus size={16} aria-hidden="true" />
          New agent
        </Button>
      }
    >
      {error ? (
        <Card className="flex flex-col items-center gap-4 p-10 text-center">
          <span
            className="flex h-12 w-12 items-center justify-center rounded-xl bg-[var(--ds-danger-soft)] text-[var(--ds-danger)]"
            aria-hidden="true"
          >
            <AlertCircle size={22} />
          </span>
          <div>
            <h2 className="text-[15px] font-semibold text-[var(--ds-text)]">
              We couldn&rsquo;t load your agents
            </h2>
            <p className="mx-auto mt-1.5 max-w-sm text-[13px] text-[var(--ds-text-muted)]">
              {error.message || 'Something went wrong while loading your agents.'}
            </p>
          </div>
          <Button variant="outline" onClick={() => void refreshBots()}>
            <RefreshCw size={16} aria-hidden="true" />
            Try again
          </Button>
        </Card>
      ) : loading && !hasAgents ? (
        <AgentsLoading />
      ) : !hasAgents ? (
        <EmptyState
          icon={BotIcon}
          title="Create your first AI agent"
          description="An AI agent answers your visitors from your own content. Name one to get started — training and customization come next."
          action={
            <Button onClick={() => setCreateOpen(true)}>
              <Plus size={16} aria-hidden="true" />
              New agent
            </Button>
          }
        />
      ) : (
        <div className="space-y-6">
          <AgentsSummary bots={bots} />
          <div className="space-y-4">
            <SectionHeader
              title="Your agents"
              description="Select an agent to view its health, knowledge and settings."
            />
            <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {bots.map((bot) => (
                <li key={bot.id}>
                  <AgentGridCard bot={bot} onChanged={handleChanged} />
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <CreateAgentDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={handleCreated}
      />
    </PageContainer>
  );
}
