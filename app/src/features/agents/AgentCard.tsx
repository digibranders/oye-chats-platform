/**
 * AgentCard (feature) - the agent tile as it appears in the AI Agents grid.
 *
 * Wraps the shared design-system `AgentCard` (identity · status · metrics ·
 * navigation) and adds two quiet identifiers ported from the legacy BotCard: a
 * masked bot key and the creation date. They sit as a muted caption below the
 * card so power users can tell agents apart at a glance without cluttering the
 * primary tile.
 */
import { type ReactElement } from 'react';
import { AgentCard as AgentCardBase } from '../../design-system';
import { type Bot } from '../../types/domain';
import { getAgentMetrics, getAgentStatus } from './agent-status';

/** Mask a bot key to first-6 + last-4, e.g. `bot-6a••••29b9`. */
function maskBotKey(botKey: string): string {
  if (botKey.length <= 10) return botKey;
  return `${botKey.slice(0, 6)}••••${botKey.slice(-4)}`;
}

/** Format an ISO date as "Jul 12, 2026"; null when absent or unparseable. */
function formatCreatedDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export interface AgentCardProps {
  bot: Bot;
}

export function AgentCard({ bot }: AgentCardProps): ReactElement {
  const { status } = getAgentStatus(bot);
  const maskedKey = bot.bot_key ? maskBotKey(bot.bot_key) : null;
  const created = formatCreatedDate(bot.created_at);

  return (
    <div className="space-y-1.5">
      <AgentCardBase
        name={bot.name}
        status={status}
        metrics={getAgentMetrics(bot)}
        avatar={bot.bot_logo ?? undefined}
        to={`/agents/${bot.id}/overview`}
      />
      {(maskedKey || created) && (
        <div className="flex items-center gap-2 px-1 text-[11px] text-[var(--ds-text-subtle)]">
          {maskedKey && <span className="min-w-0 truncate font-mono">{maskedKey}</span>}
          {maskedKey && created && <span aria-hidden="true">·</span>}
          {created && <span className="whitespace-nowrap">Created {created}</span>}
        </div>
      )}
    </div>
  );
}
