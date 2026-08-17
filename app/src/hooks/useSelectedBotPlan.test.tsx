/**
 * These two hooks feed the shell's plan chip and the per-agent feature gates.
 * The contract that matters: while the bot list is loading they must return
 * `null` (so the caller holds the gate closed / omits the chip rather than
 * flashing the wrong plan), and once resolved they read the SELECTED bot's own
 * `plan_name` / `plan_slug` — never the account-level entitlement.
 *
 * The bot context is mocked so each case sets `selectedBot` + `loading`.
 */
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bot } from '../types/domain';
import { useSelectedBotPlan } from './useSelectedBotPlan';
import { useSelectedBotPlanSlug } from './useSelectedBotPlanSlug';

interface MockBotContext {
  selectedBot: Bot | null;
  loading: boolean;
}

const botState = vi.hoisted<MockBotContext>(() => ({
  selectedBot: null,
  loading: false,
}));

vi.mock('../context/BotContext', () => ({
  useBotContext: () => botState,
}));

const professionalBot: Bot = {
  id: 1,
  name: 'Acme Support',
  plan_slug: 'professional',
  plan_name: 'Professional',
};

const freeBot: Bot = {
  id: 2,
  name: 'Side Project',
  plan_slug: 'free',
  plan_name: 'Free',
};

beforeEach(() => {
  botState.selectedBot = null;
  botState.loading = false;
});

describe('useSelectedBotPlan', () => {
  it('returns null while the bot list is loading', () => {
    botState.loading = true;
    botState.selectedBot = professionalBot; // present but must be ignored while loading
    const { result } = renderHook(() => useSelectedBotPlan());
    expect(result.current).toBeNull();
  });

  it('returns the selected bot plan name once resolved', () => {
    botState.selectedBot = professionalBot;
    const { result } = renderHook(() => useSelectedBotPlan());
    expect(result.current).toBe('Professional');
  });

  it('returns the Free name for a Free agent (does not borrow the account plan)', () => {
    botState.selectedBot = freeBot;
    const { result } = renderHook(() => useSelectedBotPlan());
    expect(result.current).toBe('Free');
  });

  it('returns null when there is no selected bot', () => {
    botState.selectedBot = null;
    const { result } = renderHook(() => useSelectedBotPlan());
    expect(result.current).toBeNull();
  });

  it('returns null when the selected bot has no plan_name', () => {
    botState.selectedBot = { id: 3, name: 'Bare' };
    const { result } = renderHook(() => useSelectedBotPlan());
    expect(result.current).toBeNull();
  });
});

describe('useSelectedBotPlanSlug', () => {
  it('returns null while the bot list is loading', () => {
    botState.loading = true;
    botState.selectedBot = professionalBot;
    const { result } = renderHook(() => useSelectedBotPlanSlug());
    expect(result.current).toBeNull();
  });

  it('returns the selected bot plan slug once resolved', () => {
    botState.selectedBot = professionalBot;
    const { result } = renderHook(() => useSelectedBotPlanSlug());
    expect(result.current).toBe('professional');
  });

  it('returns the free slug for a Free agent (holds the gate closed)', () => {
    botState.selectedBot = freeBot;
    const { result } = renderHook(() => useSelectedBotPlanSlug());
    expect(result.current).toBe('free');
  });

  it('returns null when there is no selected bot', () => {
    botState.selectedBot = null;
    const { result } = renderHook(() => useSelectedBotPlanSlug());
    expect(result.current).toBeNull();
  });

  it('returns null when the selected bot has no plan_slug', () => {
    botState.selectedBot = { id: 3, name: 'Bare' };
    const { result } = renderHook(() => useSelectedBotPlanSlug());
    expect(result.current).toBeNull();
  });
});
