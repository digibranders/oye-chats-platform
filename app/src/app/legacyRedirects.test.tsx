import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { LegacyRedirect, LegacyKnowledgeRedirect } from './legacyRedirects';
import { type Bot } from '../types/domain';
import { type BotContextValue } from '../context/BotContext';

const mockBotContext = vi.hoisted(() => vi.fn<() => BotContextValue>());

vi.mock('../context/BotContext', () => ({
  useBotContext: mockBotContext,
}));

/** Renders the resolved URL so assertions can read where a redirect landed. */
function LocationProbe() {
  const { pathname, search, hash } = useLocation();
  return <div data-testid="location">{`${pathname}${search}${hash}`}</div>;
}

function landedAt(): string {
  return screen.getByTestId('location').textContent ?? '';
}

function bot(overrides: Partial<Bot> & Pick<Bot, 'id'>): Bot {
  return { name: `Agent ${overrides.id}`, created_at: null, ...overrides };
}

function setBots(value: Partial<BotContextValue>): void {
  mockBotContext.mockReturnValue({
    bots: [],
    selectedBot: null,
    selectBot: vi.fn(),
    refreshBots: vi.fn(),
    loading: false,
    error: null,
    isAllAgents: false,
    ...value,
  });
}

describe('LegacyRedirect', () => {
  function renderAt(entry: string) {
    return render(
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/support" element={<LegacyRedirect to="/inbox" />} />
          <Route path="/build" element={<LegacyRedirect to="/launch" />} />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it('sends the old Build Studio URL to Launch Studio', () => {
    // The exact regression the user hit: Google sign-up redirected to /build,
    // which no longer exists in Admin 2.0 and rendered the in-shell 404.
    renderAt('/build');
    expect(landedAt()).toBe('/launch');
  });

  it('sends the old operator console URL to the inbox', () => {
    renderAt('/support');
    expect(landedAt()).toBe('/inbox');
  });

  it('preserves the query string so notification deep links keep their context', () => {
    // Operator push notification for a waiting visitor.
    renderAt('/support?session=abc123');
    expect(landedAt()).toBe('/inbox?session=abc123');
  });

  it('preserves the hash alongside the query string', () => {
    renderAt('/support?tab=messages#top');
    expect(landedAt()).toBe('/inbox?tab=messages#top');
  });
});

describe('LegacyKnowledgeRedirect', () => {
  function renderAt(entry: string) {
    return render(
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/knowledge" element={<LegacyKnowledgeRedirect />} />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it('resolves ?bot=<bot_key> to that agent’s knowledge tab', () => {
    setBots({
      bots: [bot({ id: 7, bot_key: 'bot-aaa' }), bot({ id: 9, bot_key: 'bot-bbb' })],
      selectedBot: bot({ id: 7, bot_key: 'bot-aaa' }),
    });
    renderAt('/knowledge?bot=bot-bbb');
    // Wins over the selected bot, and the now-redundant `bot` param is dropped.
    expect(landedAt()).toBe('/agents/9/knowledge');
  });

  it('falls back to the selected agent when no bot key is supplied', () => {
    setBots({
      bots: [bot({ id: 7, bot_key: 'bot-aaa' }), bot({ id: 9, bot_key: 'bot-bbb' })],
      selectedBot: bot({ id: 9, bot_key: 'bot-bbb' }),
    });
    renderAt('/knowledge?tab=list');
    expect(landedAt()).toBe('/agents/9/knowledge?tab=list');
  });

  it('falls back to the only agent when the workspace has exactly one', () => {
    setBots({ bots: [bot({ id: 4, bot_key: 'bot-solo' })] });
    renderAt('/knowledge');
    expect(landedAt()).toBe('/agents/4/knowledge');
  });

  it('falls back to the agent list when the agent is ambiguous', () => {
    setBots({ bots: [bot({ id: 1 }), bot({ id: 2 })] });
    renderAt('/knowledge');
    expect(landedAt()).toBe('/agents');
  });

  it('falls back to the agent list when the bot key matches nothing', () => {
    setBots({ bots: [bot({ id: 1, bot_key: 'bot-aaa' }), bot({ id: 2, bot_key: 'bot-bbb' })] });
    renderAt('/knowledge?bot=bot-deleted');
    expect(landedAt()).toBe('/agents');
  });

  it('waits for the bot list instead of redirecting on incomplete data', () => {
    setBots({ bots: [], loading: true });
    renderAt('/knowledge?bot=bot-aaa');
    // Still on /knowledge - a premature redirect would strand the user on the
    // agent list even though their bot was about to resolve.
    expect(screen.queryByTestId('location')).not.toBeInTheDocument();
  });
});
