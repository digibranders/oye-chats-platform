/**
 * The switcher's job on an agent-scoped route is to NAVIGATE. Before this was
 * wired, picking an agent at `/agents/1/knowledge` relabelled the chip and left
 * the page rendering agent 1 - `AgentContext` resolves the agent from the URL,
 * not from the shell scope. These tests pin both halves of that split, plus the
 * reconciliation that stops the persisted scope and the URL from drifting apart.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bot } from '../types/domain';
import { BotSwitcher } from './BotSwitcher';

interface MockBotContext {
  bots: Bot[];
  selectedBot: Bot | null;
  selectBot: ReturnType<typeof vi.fn>;
}

const botState = vi.hoisted<MockBotContext>(() => ({
  bots: [],
  selectedBot: null,
  selectBot: vi.fn(),
}));

vi.mock('../context/BotContext', () => ({
  useBotContext: () => botState,
}));

const acme: Bot = { id: 1, name: 'Acme Support', bot_key: 'bot-aaa111' };
const globex: Bot = { id: 2, name: 'Globex Sales', bot_key: 'bot-bbb222' };

function LocationProbe() {
  const location = useLocation();
  return <span data-testid="pathname">{location.pathname}</span>;
}

function renderSwitcher(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <BotSwitcher />
      <LocationProbe />
    </MemoryRouter>,
  );
}

function openSwitcher(): void {
  fireEvent.click(screen.getByRole('button', { name: /Switch chatbot$/ }));
}

function pathname(): string {
  return screen.getByTestId('pathname').textContent ?? '';
}

beforeEach(() => {
  botState.bots = [acme, globex];
  botState.selectedBot = acme;
  botState.selectBot = vi.fn();
});

describe('switching agents on an agent-scoped route', () => {
  it('swaps the id and keeps the user on the same tab', () => {
    renderSwitcher('/agents/1/knowledge');
    openSwitcher();
    fireEvent.click(screen.getByRole('menuitem', { name: /Globex Sales/ }));

    expect(pathname()).toBe('/agents/2/knowledge');
    expect(botState.selectBot).toHaveBeenCalledWith(globex);
  });

  it('swaps the id on the bare agent route too', () => {
    renderSwitcher('/agents/1');
    openSwitcher();
    fireEvent.click(screen.getByRole('menuitem', { name: /Globex Sales/ }));

    expect(pathname()).toBe('/agents/2');
  });

  it('does nothing when the agent picked is the one already open', () => {
    renderSwitcher('/agents/1/overview');
    openSwitcher();
    fireEvent.click(screen.getByRole('menuitem', { name: /Acme Support/ }));

    expect(pathname()).toBe('/agents/1/overview');
    expect(botState.selectBot).not.toHaveBeenCalled();
  });
});

describe('switching agents off an agent-scoped route', () => {
  it('rescopes without navigating - those pages read the shell scope', () => {
    renderSwitcher('/workspace/billing');
    openSwitcher();
    fireEvent.click(screen.getByRole('menuitem', { name: /Globex Sales/ }));

    expect(pathname()).toBe('/workspace/billing');
    expect(botState.selectBot).toHaveBeenCalledWith(globex);
  });

  it('treats the agents index as workspace-level', () => {
    renderSwitcher('/agents');
    openSwitcher();
    fireEvent.click(screen.getByRole('menuitem', { name: /Globex Sales/ }));

    expect(pathname()).toBe('/agents');
    expect(botState.selectBot).toHaveBeenCalledWith(globex);
  });
});

describe('keeping the persisted scope and the URL in agreement', () => {
  it('adopts the URL agent when the shell scope points elsewhere', () => {
    // How the Agents grid leaves things: it navigates into an agent without
    // touching `selectBot`, so localStorage still holds the previous one.
    botState.selectedBot = acme;
    renderSwitcher('/agents/2/overview');

    expect(botState.selectBot).toHaveBeenCalledWith(globex);
    expect(screen.getByRole('button', { name: /Switch chatbot$/ })).toHaveAccessibleName(
      /Globex Sales/,
    );
  });

  it('leaves the scope alone when the URL names an agent this workspace does not have', () => {
    renderSwitcher('/agents/999/overview');

    expect(botState.selectBot).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Switch chatbot$/ })).toHaveAccessibleName(
      /Acme Support/,
    );
  });

  it('leaves the scope alone on workspace-level routes', () => {
    renderSwitcher('/leads');

    expect(botState.selectBot).not.toHaveBeenCalled();
  });
});

describe('filtering a long agent list', () => {
  const many: Bot[] = Array.from({ length: 8 }, (_, index) => ({
    id: index + 1,
    name: `Agent ${index + 1}`,
    bot_key: `bot-key${index + 1}`,
  }));

  it('stays out of the way on a short list', () => {
    renderSwitcher('/agents/1/overview');
    openSwitcher();

    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  });

  it('appears once the list is long enough to need it', () => {
    botState.bots = many;
    botState.selectedBot = many[0];
    renderSwitcher('/agents/1/overview');
    openSwitcher();

    expect(screen.getByRole('searchbox', { name: 'Filter chatbots' })).toBeInTheDocument();
    expect(screen.getAllByRole('menuitem')).toHaveLength(8);
  });

  it('narrows the list by name and by bot key', () => {
    botState.bots = many;
    botState.selectedBot = many[0];
    renderSwitcher('/agents/1/overview');
    openSwitcher();

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'agent 3' } });
    expect(screen.getAllByRole('menuitem')).toHaveLength(1);

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'bot-key5' } });
    expect(screen.getAllByRole('menuitem')).toHaveLength(1);
  });

  it('explains an empty result instead of showing a blank panel', () => {
    botState.bots = many;
    botState.selectedBot = many[0];
    renderSwitcher('/agents/1/overview');
    openSwitcher();

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'nothing here' } });

    expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
    expect(screen.getByRole('status')).toHaveTextContent('No chatbots match');
  });

  it('forgets the query once the popover closes', () => {
    botState.bots = many;
    botState.selectedBot = many[0];
    renderSwitcher('/agents/1/overview');
    openSwitcher();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'agent 3' } });

    openSwitcher(); // toggles closed
    openSwitcher(); // and back open

    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(screen.getAllByRole('menuitem')).toHaveLength(8);
  });
});
