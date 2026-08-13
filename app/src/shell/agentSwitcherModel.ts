import type { Bot } from '../types/domain';

/**
 * agentSwitcherModel - the pure logic behind the top-bar `BotSwitcher`.
 *
 * Two concerns live here, both extracted so they can be tested without
 * mounting a router or a popover:
 *
 *  1. **Agent-scoped route rewriting.** Agent pages are URL objects
 *     (`/agents/:agentId/<tab>`) and `AgentContext` resolves the active agent
 *     from that param, NOT from `BotContext.selectedBot`. Switching agents on
 *     such a route therefore has to swap the id inside the path - updating the
 *     shell scope alone leaves the page rendering the previous agent.
 *  2. **Filtering.** The switcher lists every agent in the workspace; past a
 *     handful that list needs a filter to stay usable.
 */

/**
 * The `/agents/<id>` prefix of an agent-scoped path.
 *
 * Only a numeric id counts: `Bot.id` is numeric and `AgentContext` matches on
 * `String(bot.id)`, so a non-numeric segment (a future `/agents/new`-style
 * sub-route) is deliberately NOT treated as an agent scope and is left alone.
 * The lookahead keeps `/agents/12` from matching inside `/agents/123`.
 */
const AGENT_ROUTE_PREFIX = /^\/agents\/(\d+)(?=[/?#]|$)/;

/**
 * The `:agentId` a path is scoped to, or `null` when the path is not
 * agent-scoped (`/agents` itself, `/workspace/*`, `/leads`, ...).
 */
export function agentIdFromPath(pathname: string): string | null {
  const match = AGENT_ROUTE_PREFIX.exec(pathname);
  return match === null ? null : match[1];
}

/**
 * Rewrite an agent-scoped path onto `agentId`, keeping everything after the id
 * intact so the user stays on the tab they were reading - an agency comparing
 * Analytics across client sites must not be bounced back to Overview.
 *
 * Returns `null` when `pathname` is not agent-scoped; that is the caller's
 * signal to leave the URL alone (workspace-level pages legitimately read
 * `BotContext.selectedBot`, so navigating them would be wrong).
 *
 * Callers pass a bare `pathname`, so the current query string and hash are
 * dropped by construction. That is intended: those params (a filter, a
 * selected conversation, an open source) belong to the agent being switched
 * away from and would not resolve under the new one.
 */
export function swapAgentInPath(pathname: string, agentId: number | string): string | null {
  const match = AGENT_ROUTE_PREFIX.exec(pathname);
  if (match === null) return null;
  return `/agents/${String(agentId)}${pathname.slice(match[0].length)}`;
}

/**
 * Agent count at which the switcher grows a filter input.
 *
 * The list scrolls inside a `max-h-80` (320px) area and each row is ~48px, so
 * the seventh agent is the first one that can't be seen without scrolling -
 * exactly the point where scanning stops being viable and filtering starts
 * earning its keep. Below it the input would be chrome with nothing to do.
 */
export const AGENT_FILTER_THRESHOLD = 7;

/** Is this workspace's agent list long enough to need the filter input? */
export function shouldShowAgentFilter(agentCount: number): boolean {
  return agentCount >= AGENT_FILTER_THRESHOLD;
}

/** Case-insensitive substring test that treats a missing field as no match. */
function fieldMatches(value: string | null | undefined, needle: string): boolean {
  return typeof value === 'string' && value.toLowerCase().includes(needle);
}

/**
 * Agents matching `query`, tested against the two identifiers the switcher
 * actually renders: the agent's name and its `bot_key`. Fields are matched
 * independently so a query can never straddle the boundary between them.
 *
 * A blank query matches everything.
 */
export function filterAgents(bots: readonly Bot[], query: string): Bot[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return bots.slice();
  return bots.filter((bot) => fieldMatches(bot.name, needle) || fieldMatches(bot.bot_key, needle));
}
