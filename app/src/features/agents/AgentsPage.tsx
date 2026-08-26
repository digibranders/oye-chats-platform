import { useCallback, useState, type ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bot as BotIcon, Plus, AlertCircle, RefreshCw, Wand2 } from 'lucide-react';
import {
  Button,
  Card,
  EmptyState,
  PageContainer,
  Skeleton,
} from '../../design-system';
import { useBotContext } from '../../context/BotContext';
import { useWorkspace } from '../../context/WorkspaceContext';
import { useEntitlements } from '../../hooks/useEntitlements';
import { type Bot } from '../../types/domain';
import { hasLaunchProgress, resumeLaunchPath } from '../launch-studio/resume';
import { AgentCard } from './AgentCard';
import { CreateAgentDialog } from './CreateAgentDialog';
import { AgentActionsMenu } from './AgentActionsMenu';
import { resolveAgentCreationGate } from './agentLimit';
import { useTranslation } from '../../i18n/useTranslation';

/**
 * One agent in the grid: the shared, fully-navigational <AgentCard> tile with
 * the actions "⋯" menu overlaid in its top-right corner. The menu is a sibling
 * of the card's link (not a child), so both stay independent, accessible
 * controls - clicking the tile opens the agent, the menu handles the rest.
 */
function AgentGridCard({ bot, onChanged }: { bot: Bot; onChanged: () => void }): ReactElement {
  return (
    <div className="relative">
      <AgentCard bot={bot} />
      <div className="absolute right-3 top-3">
        <AgentActionsMenu bot={bot} onChanged={onChanged} />
      </div>
    </div>
  );
}

/** Placeholder grid shown while the agent list is loading. */
function AgentsLoading(): ReactElement {
  const { t } = useTranslation();
  return (
    <div className="space-y-6">
      <span className="sr-only" role="status">
        {t('agents.loadingYourAgents') || 'Loading your agents…'}
      </span>
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
    </div>
  );
}

/**
 * AgentsPage - the AI Agents list. Answers exactly one question: "Which agents
 * do I have?"
 *
 * A summary of portfolio health, then a grid of agent tiles that each navigate
 * to the agent's Overview. Data comes from the reused BotContext (an AI Agent
 * IS a legacy Bot), so `loading`/`error` are read straight from the provider -
 * no local fetch state, no synchronous setState in an effect. Creating an agent
 * reuses the legacy `createBot` API via the CreateAgentDialog.
 *
 * Add-Agent reads the plan's `bots` quota so the create dialog can say up front
 * that this agent will need its own subscription - under the per-bot billing
 * model only the first agent is free. The control itself is never taken away:
 * that second agent is a sale, and `CreateAgentDialog` completes it by routing
 * the server's 402 `must_subscribe` into a plan picker + per-agent checkout.
 * The quota is advisory copy; `can_client_add_new_bot` server-side is the rule.
 */
export function AgentsPage(): ReactElement {
  const { t } = useTranslation();
  const { bots, loading, error, refreshBots } = useBotContext();
  const { currentWorkspaceId } = useWorkspace();
  const { limitFor, planName } = useEntitlements();
  const [createOpen, setCreateOpen] = useState(false);
  const navigate = useNavigate();

  // Counted from the live agent list rather than `entitlements.usage.bots`,
  // which is only refetched on mount and on workspace switch and so would
  // still read 0 right after the first agent is created. `deleteBot` is a hard
  // delete, so the list matches the server's active-agent count.
  const creationGate = resolveAgentCreationGate(bots.length, limitFor('bots'));

  // Always open the create dialog. Whether the new agent is free or needs a paid
  // plan is decided inside the dialog (free → created immediately; paywalled →
  // it advances to a pricing step and runs the per-agent checkout).
  const handleAddAgent = useCallback((): void => {
    setCreateOpen(true);
  }, []);

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

  // Paid-agent path: the agent is materialised server-side after checkout. Land
  // on its Overview when we know the id; otherwise (webhook still in flight)
  // return to the list, where it appears as soon as it's created.
  const handleCheckoutComplete = useCallback(
    async (botId: number): Promise<void> => {
      setCreateOpen(false);
      await refreshBots();
      navigate(botId > 0 ? `/agents/${botId}/overview` : '/agents');
    },
    [refreshBots, navigate],
  );

  const handleChanged = useCallback((): void => {
    void refreshBots();
  }, [refreshBots]);

  const hasAgents = bots.length > 0;
  // Only offered when the user actually abandoned Launch Studio mid-flow, in
  // THIS workspace. A workspace with no agents already gets the guided path
  // from the empty state below, and a finished workspace shouldn't be pulled
  // back into onboarding. The workspace scope also stops a second account on
  // a shared browser inheriting the first account's progress.
  const showResumeSetup = hasAgents && hasLaunchProgress(currentWorkspaceId);

  return (
    <PageContainer
      title={t('agents.yourChatbots') || 'Your chatbots'}
      description={t('agents.selectAChatbotToView') || 'Select a chatbot to view its health, knowledge and settings.'}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {/* Launch Studio saves progress but had no door back in once the user
              closed it (its only entry was Home's zero-agent empty state, and
              the flow itself creates the first agent). Surface the resume here
              while onboarding is unfinished. */}
          {showResumeSetup && (
            <Button variant="outline" onClick={() => navigate(resumeLaunchPath())}>
              <Wand2 size={16} aria-hidden="true" />
              {t('agents.resumeSetup') || 'Resume setup'}
            </Button>
          )}
          <Button onClick={handleAddAgent}>
            <Plus size={16} aria-hidden="true" />
            {t('agents.newChatbot') || 'New chatbot'}
          </Button>
        </div>
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
              {t('agents.couldntLoadYourChatbots') || 'We couldn’t load your chatbots'}
            </h2>
            <p className="mx-auto mt-1.5 max-w-sm text-[13px] text-[var(--ds-text-muted)]">
              {error.message || t('agents.somethingWentWrongWhileLoading') || 'Something went wrong while loading your chatbots.'}
            </p>
          </div>
          <Button variant="outline" onClick={() => void refreshBots()}>
            <RefreshCw size={16} aria-hidden="true" />
            {t('agents.tryAgain') || 'Try again'}
          </Button>
        </Card>
      ) : loading && !hasAgents ? (
        <AgentsLoading />
      ) : !hasAgents ? (
        <EmptyState
          icon={BotIcon}
          title={t('agents.createYourFirstAiChatbot') || 'Create your first AI chatbot'}
          description={t('agents.anAiChatbotAnswersYour') || 'An AI chatbot answers your visitors from your own content. Name one to get started - training and customization come next.'}
          action={
            <Button onClick={handleAddAgent}>
              <Plus size={16} aria-hidden="true" />
              {t('agents.newChatbot') || 'New chatbot'}
            </Button>
          }
        />
      ) : (
        <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {bots.map((bot) => (
            <li key={bot.id}>
              <AgentGridCard bot={bot} onChanged={handleChanged} />
            </li>
          ))}
        </ul>
      )}

      <CreateAgentDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={handleCreated}
        onCheckoutComplete={handleCheckoutComplete}
        gate={creationGate}
        planName={planName}
      />
    </PageContainer>
  );
}
