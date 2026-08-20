import { describe, expect, it } from 'vitest';
import { parseCreditBalance, resolveScopedPool } from './usage-model';

/**
 * A paused agent at the parsing boundary.
 *
 * `GET /credits/balance` no longer filters `Bot.is_active`, so `bots[]` can now
 * carry an agent that is switched off but still funded. Two things have to hold
 * at this layer, and neither is visible in a component test: the entry survives
 * parsing with its money intact, and a payload that predates the field is not
 * read as a workspace full of paused agents.
 */
const ENTRY = {
  bot_id: 7,
  bot_name: 'Acme Support',
  bot_key: 'bot-acme',
  plan_name: 'Standard',
  monthly_grant: 3000,
  plan: 1800,
  topup: 400,
  total: 2200,
  soonest_expiry: '2026-09-15T00:00:00Z',
  period_start: '2026-08-01T00:00:00Z',
  resets_at: '2026-09-01T00:00:00Z',
  usage: { ai_chat: { credits_used: 1200, event_count: 1200 } },
  limits: {},
  limit_usage: {},
};

describe('parseCreditBalance — paused agents', () => {
  it('keeps a paused agent’s balance, usage and expiry rather than dropping it', () => {
    const balance = parseCreditBalance({
      plan: 0,
      topup: 0,
      total: 0,
      bots: [{ ...ENTRY, is_active: false }],
      account_pool_bot_count: 0,
    });

    expect(balance.botCredits).toHaveLength(1);
    const [agent] = balance.botCredits;
    expect(agent.isActive).toBe(false);
    expect(agent.totalRemaining).toBe(2200);
    expect(agent.soonestExpiry).toBe('2026-09-15T00:00:00Z');
    expect(agent.periodCreditsUsed).toBe(1200);
    // It is still part of the workspace position: the money is real.
    expect(balance.totalRemaining).toBe(2200);
  });

  it('treats an absent is_active as active, so an older payload pauses nothing', () => {
    const balance = parseCreditBalance({ bots: [ENTRY], account_pool_bot_count: 0 });
    expect(balance.botCredits[0].isActive).toBe(true);
  });

  it('keeps the pause on the scoped pool, which is what the page renders', () => {
    const balance = parseCreditBalance({
      bots: [{ ...ENTRY, is_active: false }],
      account_pool_bot_count: 1,
    });
    expect(resolveScopedPool(balance, 7).isActive).toBe(false);
    // The workspace aggregate is never "paused" — individual agents are.
    expect(resolveScopedPool(balance, null).isActive).toBe(true);
  });
});
