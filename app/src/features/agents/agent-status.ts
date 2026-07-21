import { type Bot } from '../../types/domain';
import { type AgentCardMetric, type AgentCardStatus } from '../../design-system/components/AgentCard';

/**
 * Derived health of an AI agent, from the intrinsic fields on the reused Bot
 * object (no extra network calls). This is the single source of truth the list
 * page and its summary tiles read, so status language stays consistent.
 *
 *   live       — trained AND the widget is installed on the customer's site.
 *   ready      — trained, but not yet deployed anywhere.
 *   training   — a crawl is in progress right now.
 *   attention  — the last crawl failed or found no usable content.
 *   draft      — created but never trained.
 */
export type AgentHealth = 'live' | 'ready' | 'training' | 'attention' | 'draft';

export interface AgentStatusInfo {
  health: AgentHealth;
  /** Badge shape consumed directly by <AgentCard status=… />. */
  status: AgentCardStatus;
}

const STATUS_BY_HEALTH: Record<AgentHealth, AgentCardStatus> = {
  live: { label: 'Live', tone: 'success' },
  ready: { label: 'Ready to deploy', tone: 'info' },
  training: { label: 'Training', tone: 'warning' },
  attention: { label: 'Needs attention', tone: 'danger' },
  draft: { label: 'Needs training', tone: 'neutral' },
};

/** Classify one agent's health from its trained/installed/crawl signals. */
export function getAgentHealth(bot: Bot): AgentHealth {
  const chunks = bot.indexed_chunk_count ?? 0;
  const installed = Boolean(bot.widget_installed_at);
  const crawl = bot.last_crawl_status ?? null;

  if (crawl === 'running') return 'training';
  if (crawl === 'failed' || crawl === 'no_content') return 'attention';
  if (chunks > 0 && installed) return 'live';
  if (chunks > 0) return 'ready';
  return 'draft';
}

/** Full status info (health + badge) for a single agent. */
export function getAgentStatus(bot: Bot): AgentStatusInfo {
  const health = getAgentHealth(bot);
  return { health, status: STATUS_BY_HEALTH[health] };
}

/**
 * The two headline figures shown on each agent tile. Intentionally limited to
 * facts already present on the Bot object; richer per-agent KPIs (conversations,
 * leads) require per-bot stats calls and are tracked as a follow-up.
 */
export function getAgentMetrics(bot: Bot): AgentCardMetric[] {
  const chunks = bot.indexed_chunk_count ?? 0;
  return [
    {
      label: 'Knowledge',
      value: chunks > 0 ? `${chunks.toLocaleString()} passages` : 'Not trained yet',
    },
    {
      label: 'Widget',
      value: bot.widget_installed_at ? 'Installed' : 'Not installed',
    },
  ];
}

export interface AgentPortfolioSummary {
  /** Total number of agents in the workspace. */
  total: number;
  /** Agents that are trained and installed. */
  live: number;
  /** Agents with a crawl in progress. */
  training: number;
  /** Agents that need setup or intervention (draft or failed). */
  needsSetup: number;
}

/** Roll the agent list up into the portfolio counts shown in the summary row. */
export function summarizeAgents(bots: Bot[]): AgentPortfolioSummary {
  const summary: AgentPortfolioSummary = { total: bots.length, live: 0, training: 0, needsSetup: 0 };
  for (const bot of bots) {
    const health = getAgentHealth(bot);
    if (health === 'live') summary.live += 1;
    else if (health === 'training') summary.training += 1;
    else summary.needsSetup += 1;
  }
  return summary;
}
