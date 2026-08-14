/**
 * Every case here is written against the server's own two-part decision in
 * `bot_routes.create_bot` (`can_client_add_new_bot` widened by
 * `_plan_bots_limit_allows`), because that is what actually answers 402. A
 * gate that disagreed with it would either paywall a free agent or promise a
 * free one and then charge for it.
 */
import { describe, expect, it } from 'vitest';

import {
  UNLIMITED_AGENTS,
  describeAgentLimit,
  isAtAgentLimit,
  resolveAgentCreationGate,
} from './agentLimit';

describe('isAtAgentLimit', () => {
  it('always allows the first agent, whatever the quota says', () => {
    // Server rule 1: `can_client_add_new_bot` allows at 0 active bots and the
    // quota check never runs, so even an unreadable quota must not block here.
    expect(isAtAgentLimit(0, 1)).toBe(false);
    expect(isAtAgentLimit(0, 0)).toBe(false);
    expect(isAtAgentLimit(0, UNLIMITED_AGENTS)).toBe(false);
  });

  it('blocks the second agent on the four plans that include one', () => {
    // Free / Starter / Standard / Professional all declare `bots: 1`.
    expect(isAtAgentLimit(1, 1)).toBe(true);
    expect(isAtAgentLimit(4, 1)).toBe(true);
  });

  it('never blocks on an unlimited quota', () => {
    // Enterprise declares `bots: -1` and pools every agent under one plan.
    expect(isAtAgentLimit(1, UNLIMITED_AGENTS)).toBe(false);
    expect(isAtAgentLimit(40, UNLIMITED_AGENTS)).toBe(false);
  });

  it('treats the quota as a ceiling, not a magic number', () => {
    expect(isAtAgentLimit(2, 3)).toBe(false);
    expect(isAtAgentLimit(3, 3)).toBe(true);
    expect(isAtAgentLimit(4, 3)).toBe(true);
  });

  it('matches the server when the plan declares no readable quota', () => {
    // `limitFor` answers 0 for a missing key and `within_limit(0)` is false,
    // so an account that already has an agent is at its limit.
    expect(isAtAgentLimit(1, 0)).toBe(true);
  });

  it('does not paywall on non-finite input', () => {
    expect(isAtAgentLimit(Number.NaN, 1)).toBe(false);
    expect(isAtAgentLimit(1, Number.NaN)).toBe(false);
  });
});

describe('resolveAgentCreationGate', () => {
  it('reports an included agent when the plan still funds one', () => {
    expect(resolveAgentCreationGate(0, 1)).toEqual({ kind: 'included' });
    expect(resolveAgentCreationGate(9, UNLIMITED_AGENTS)).toEqual({ kind: 'included' });
  });

  it('carries the numbers the notice needs when a plan is required', () => {
    expect(resolveAgentCreationGate(2, 1)).toEqual({
      kind: 'requires_plan',
      agentCount: 2,
      agentLimit: 1,
    });
  });
});

describe('describeAgentLimit', () => {
  it('says nothing at all when the agent is included', () => {
    expect(describeAgentLimit(resolveAgentCreationGate(0, 1), 'Free')).toBeNull();
  });

  it('names the plan and its quota so the claim is checkable', () => {
    const copy = describeAgentLimit(resolveAgentCreationGate(1, 1), 'Starter');
    expect(copy).toContain('Starter');
    expect(copy).toContain('1 chatbot');
    expect(copy).toContain('you already have 1');
  });

  it('pluralises a multi-agent quota', () => {
    expect(describeAgentLimit(resolveAgentCreationGate(3, 3), 'Agency')).toContain('3 chatbots');
  });

  it('falls back to a neutral plan name rather than an empty sentence', () => {
    expect(describeAgentLimit(resolveAgentCreationGate(1, 1), '  ')).toMatch(/^Your plan includes/);
  });

  it('drops the quota claim entirely when the plan data is unreadable', () => {
    const copy = describeAgentLimit(resolveAgentCreationGate(1, 0), 'Free');
    expect(copy).toBe('Each additional chatbot runs on its own plan, with its own credits and knowledge base.');
    expect(copy).not.toContain('0');
  });
});
