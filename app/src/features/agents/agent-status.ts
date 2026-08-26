import { type Bot } from '../../types/domain';
import { type AgentCardMetric, type AgentCardStatus } from '../../design-system/components/AgentCard';
import { t as translateNow } from '../../i18n/i18n';
import { formatNumber } from '../../i18n/formatters';

/**
 * Derived health of an AI agent, from the intrinsic fields on the reused Bot
 * object (no extra network calls). This is the single source of truth the list
 * page and its summary tiles read, so status language stays consistent.
 *
 *   live       - trained AND the widget is installed on the customer's site.
 *   ready      - trained, but not yet deployed anywhere.
 *   training   - a crawl is in progress right now.
 *   attention  - untrained AND the last crawl failed or found no usable content.
 *   draft      - created but never trained.
 */
export type AgentHealth = 'live' | 'ready' | 'training' | 'attention' | 'draft';

export interface AgentStatusInfo {
  health: AgentHealth;
  /** Badge shape consumed directly by <AgentCard status=… />. */
  status: AgentCardStatus;
}

// Tone is a design decision and never varies by language, so it stays here.
// The label does vary, and this table is built at import - before any locale
// exists - so the English is the fallback and `getAgentStatus` resolves the
// real one per call, at render time.
// @i18n-exempt: resolved at the render site. `getAgentStatus` below looks up
// `agents.status.<health>` per call, so these labels are that lookup's English
// fallback and never freeze a language. Tone is design, not copy.
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

  // Order matters (same rule as agent-health.ts): `indexed_chunk_count` is
  // what the agent CURRENTLY knows; `last_crawl_status` only describes the
  // last training ATTEMPT. Checking the attempt first made a single failed
  // recrawl flip an agent holding thousands of passages to "Needs attention"
  // here while the Overview hero simultaneously said "Trained".
  if (crawl === 'running') return 'training';
  if (chunks > 0 && installed) return 'live';
  if (chunks > 0) return 'ready';
  if (crawl === 'failed' || crawl === 'no_content') return 'attention';
  return 'draft';
}

/** Full status info (health + badge) for a single agent. */
export function getAgentStatus(bot: Bot): AgentStatusInfo {
  const health = getAgentHealth(bot);
  const base = STATUS_BY_HEALTH[health];
  return {
    health,
    status: { ...base, label: translateNow(`agents.status.${health}`) || base.label },
  };
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
      label: translateNow('agents.knowledge') || 'Knowledge',
      value:
        chunks > 0
          ? translateNow('agents.passageCount', { count: formatNumber(chunks) }) ||
            `${formatNumber(chunks)} passages`
          : translateNow('agents.notTrainedYet') || 'Not trained yet',
    },
    {
      label: translateNow('agents.widget') || 'Widget',
      value: bot.widget_installed_at
        ? translateNow('agents.installed') || 'Installed'
        : translateNow('agents.notInstalled') || 'Not installed',
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
  /**
   * Agents not yet serving visitors - i.e. every non-live, non-training agent:
   * draft (never trained), ready (trained but not deployed), or attention
   * (crawl failed / no content). Deliberately inclusive so the tile total plus
   * live plus training reconciles with the agent count.
   */
  notLive: number;
}

/** Roll the agent list up into the portfolio counts shown in the summary row. */
export function summarizeAgents(bots: Bot[]): AgentPortfolioSummary {
  const summary: AgentPortfolioSummary = { total: bots.length, live: 0, training: 0, notLive: 0 };
  for (const bot of bots) {
    const health = getAgentHealth(bot);
    if (health === 'live') summary.live += 1;
    else if (health === 'training') summary.training += 1;
    else summary.notLive += 1;
  }
  return summary;
}
