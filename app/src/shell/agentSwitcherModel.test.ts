/**
 * The switcher's contract with the router. `AgentContext` resolves the active
 * agent from `:agentId` in the URL, so on an agent-scoped route these two
 * functions are the entire difference between switching agents and merely
 * relabelling a chip. The cases below are written against the route table in
 * `app/routes.tsx`, not against what the component happens to do.
 */
import { describe, expect, it } from 'vitest';

import type { Bot } from '../types/domain';
import {
  AGENT_FILTER_THRESHOLD,
  agentIdFromPath,
  filterAgents,
  shouldShowAgentFilter,
  swapAgentInPath,
} from './agentSwitcherModel';

function bot(id: number, name: string, botKey?: string): Bot {
  return { id, name, bot_key: botKey };
}

describe('agentIdFromPath', () => {
  it('reads the id off every agent tab', () => {
    for (const tab of ['overview', 'knowledge', 'experience', 'channels', 'advanced']) {
      expect(agentIdFromPath(`/agents/42/${tab}`)).toBe('42');
    }
  });

  it('reads the id off the bare agent route', () => {
    expect(agentIdFromPath('/agents/42')).toBe('42');
    expect(agentIdFromPath('/agents/42/')).toBe('42');
  });

  it('treats the agents index as workspace-level, not agent-scoped', () => {
    expect(agentIdFromPath('/agents')).toBeNull();
    expect(agentIdFromPath('/agents/')).toBeNull();
  });

  it('ignores every non-agent route', () => {
    expect(agentIdFromPath('/')).toBeNull();
    expect(agentIdFromPath('/leads')).toBeNull();
    expect(agentIdFromPath('/inbox')).toBeNull();
    expect(agentIdFromPath('/analytics')).toBeNull();
    expect(agentIdFromPath('/workspace/billing')).toBeNull();
    expect(agentIdFromPath('/launch/welcome')).toBeNull();
  });

  it('does not match a path that merely starts with the same letters', () => {
    expect(agentIdFromPath('/agentsettings/1')).toBeNull();
    expect(agentIdFromPath('/agents-archive/1')).toBeNull();
  });

  it('requires a numeric id, so a future word sub-route is left alone', () => {
    expect(agentIdFromPath('/agents/new')).toBeNull();
    expect(agentIdFromPath('/agents/new/overview')).toBeNull();
  });
});

describe('swapAgentInPath', () => {
  it('keeps the user on the same tab', () => {
    expect(swapAgentInPath('/agents/12/knowledge', 34)).toBe('/agents/34/knowledge');
    expect(swapAgentInPath('/agents/12/channels', 34)).toBe('/agents/34/channels');
  });

  it('swaps the id on the bare agent route', () => {
    expect(swapAgentInPath('/agents/12', 34)).toBe('/agents/34');
    expect(swapAgentInPath('/agents/12/', 34)).toBe('/agents/34/');
  });

  it('replaces only the id segment, never a lookalike further down the path', () => {
    expect(swapAgentInPath('/agents/12/knowledge/12', 34)).toBe('/agents/34/knowledge/12');
  });

  it('does not confuse a prefix of the id with the id', () => {
    // `/agents/1` must not match inside `/agents/123`.
    expect(swapAgentInPath('/agents/123/overview', 4)).toBe('/agents/4/overview');
  });

  it('accepts the id as a string as well as a number', () => {
    expect(swapAgentInPath('/agents/12/overview', '34')).toBe('/agents/34/overview');
  });

  it('is a no-op path when the target is the agent already open', () => {
    expect(swapAgentInPath('/agents/12/overview', 12)).toBe('/agents/12/overview');
  });

  it('returns null off agent-scoped routes, so those keep using the shell scope', () => {
    expect(swapAgentInPath('/agents', 34)).toBeNull();
    expect(swapAgentInPath('/workspace/billing', 34)).toBeNull();
    expect(swapAgentInPath('/leads', 34)).toBeNull();
    expect(swapAgentInPath('/', 34)).toBeNull();
  });
});

describe('the filter threshold', () => {
  it('stays hidden while the list still fits the popover', () => {
    expect(shouldShowAgentFilter(0)).toBe(false);
    expect(shouldShowAgentFilter(3)).toBe(false);
    expect(shouldShowAgentFilter(AGENT_FILTER_THRESHOLD - 1)).toBe(false);
  });

  it('appears once the list starts scrolling', () => {
    expect(shouldShowAgentFilter(AGENT_FILTER_THRESHOLD)).toBe(true);
    expect(shouldShowAgentFilter(40)).toBe(true);
  });
});

describe('filterAgents', () => {
  const bots = [
    bot(1, 'Acme Support', 'bot-aaa111'),
    bot(2, 'Globex Sales', 'bot-bbb222'),
    bot(3, 'Initech Helpdesk', 'bot-ccc333'),
  ];

  it('returns everything for a blank or whitespace query', () => {
    expect(filterAgents(bots, '')).toHaveLength(3);
    expect(filterAgents(bots, '   ')).toHaveLength(3);
  });

  it('matches the agent name, case-insensitively and mid-word', () => {
    expect(filterAgents(bots, 'globex').map((b) => b.id)).toEqual([2]);
    expect(filterAgents(bots, 'HELP').map((b) => b.id)).toEqual([3]);
  });

  it('matches the bot key, which is how an agency tells two same-named agents apart', () => {
    expect(filterAgents(bots, 'bbb222').map((b) => b.id)).toEqual([2]);
    expect(filterAgents(bots, 'bot-').map((b) => b.id)).toEqual([1, 2, 3]);
  });

  it('trims the query so a trailing space does not empty the list', () => {
    expect(filterAgents(bots, ' acme ').map((b) => b.id)).toEqual([1]);
  });

  it('never matches across the name/key boundary', () => {
    expect(filterAgents(bots, 'Acme Support bot-aaa111')).toEqual([]);
  });

  it('returns nothing when nothing matches', () => {
    expect(filterAgents(bots, 'zzz')).toEqual([]);
  });

  it('tolerates an agent with no bot key yet', () => {
    const pending = [bot(4, 'Just created')];
    expect(filterAgents(pending, 'created').map((b) => b.id)).toEqual([4]);
    expect(filterAgents(pending, 'bot-')).toEqual([]);
  });

  it('does not mutate or alias the input list', () => {
    const result = filterAgents(bots, '');
    expect(result).not.toBe(bots);
    expect(result).toEqual(bots);
  });
});
