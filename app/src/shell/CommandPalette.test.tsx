import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandPalette } from './CommandPalette';
import { useBotContext } from '../context/BotContext';
import { useWorkspace } from '../context/WorkspaceContext';
import type { Bot } from '../types/domain';

/**
 * The user's own report: "business hour" returned nothing, though Business
 * Hours is a real, named field on every chatbot. That was a coverage gap, not
 * a matching bug — see
 * docs/superpowers/specs/2026-09-10-command-palette-settings-search-design.md.
 * These tests pin the fix: the setting is findable by name, word order does
 * not matter, and picking it lands on the right chatbot's Experience tab.
 */

vi.mock('../context/BotContext', () => ({ useBotContext: vi.fn() }));
vi.mock('../context/WorkspaceContext', () => ({ useWorkspace: vi.fn() }));

// The palette persists its "recent" picks to REAL localStorage
// (CommandPalette.tsx's `rememberRecent`), and the global test setup
// (src/test/setup.ts) only unmounts between tests — it never clears storage.
// Without this, the "picking a result" tests below (which click a result,
// writing it to localStorage) would leak into "group placement", excluding
// that item from its group via CommandPalette's own `!recentIds.has(...)`
// filter and making the test's pass/fail depend on file order.
beforeEach(() => {
  localStorage.clear();
});

const BOTS: Bot[] = [
  { id: 1, name: 'Acme Support', bot_key: 'bot-acme' },
  { id: 2, name: 'Northwind Sales', bot_key: 'bot-northwind' },
];

const PLACEHOLDER = 'Jump to a chatbot or a page…';

function Probe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function renderPalette({ bots = BOTS, isOperator = false }: { bots?: Bot[]; isOperator?: boolean } = {}) {
  vi.mocked(useBotContext).mockReturnValue({ bots } as ReturnType<typeof useBotContext>);
  vi.mocked(useWorkspace).mockReturnValue({ isOperator } as ReturnType<typeof useWorkspace>);
  return render(
    <MemoryRouter initialEntries={['/']}>
      <CommandPalette open onOpenChange={() => {}} />
      <Probe />
    </MemoryRouter>,
  );
}

describe('finding a setting by name', () => {
  it('finds Business Hours, which the palette could not find before this change', async () => {
    renderPalette();
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'business hour');

    expect(screen.getByText('Settings')).toBeInTheDocument();
    // Two chatbots, so the setting is disambiguated per bot — the same
    // convention the existing per-bot tab rows already use.
    expect(screen.getByRole('option', { name: 'Acme Support — Business Hours' })).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: 'Northwind Sales — Business Hours' }),
    ).toBeInTheDocument();
  });

  it('matches the query words in either order', async () => {
    renderPalette();
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'hours business');

    expect(screen.getByRole('option', { name: 'Acme Support — Business Hours' })).toBeInTheDocument();
  });

  it('finds a workspace setting by its synonym, not only its literal label', async () => {
    renderPalette();
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'rotate');

    expect(screen.getByRole('option', { name: 'API Key' })).toBeInTheDocument();
  });
});

describe('picking a result', () => {
  it('navigates to the exact chatbot and tab, including per-bot disambiguation', async () => {
    renderPalette();
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'business hour');
    await user.click(screen.getByRole('option', { name: 'Northwind Sales — Business Hours' }));

    expect(screen.getByTestId('location')).toHaveTextContent('/chatbots/2/experience');
  });

  it('navigates a workspace setting to its exact URL, including the tab query param', async () => {
    renderPalette();
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'webhook');
    await user.click(screen.getByRole('option', { name: 'Webhooks' }));

    expect(screen.getByTestId('location')).toHaveTextContent('/settings/integrations?tab=webhooks');
  });
});

describe('a single chatbot', () => {
  it('still disambiguates by name, unchanged from how the existing tab rows already behave', async () => {
    renderPalette({ bots: [BOTS[0]!] });
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'business hour');

    expect(screen.getByRole('option', { name: 'Acme Support — Business Hours' })).toBeInTheDocument();
  });
});

describe('an operator', () => {
  it('sees no Settings group — operators have no Settings destination at all', async () => {
    renderPalette({ isOperator: true });
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'business hour');

    expect(screen.queryByText('Settings')).toBeNull();
    expect(screen.queryByRole('option', { name: /business hours/i })).toBeNull();
  });
});

describe('group placement', () => {
  it('renders Settings after Chatbots, and Chatbots keeps its existing position', async () => {
    renderPalette();
    const user = userEvent.setup();
    // Broad enough to surface both a chatbot row and a settings row.
    await user.type(screen.getByPlaceholderText(PLACEHOLDER), 'a');

    const chatbotsGroup = screen.getByRole('group', { name: 'Chatbots' });
    const settingsGroup = screen.getByRole('group', { name: 'Settings' });
    // Bitmask check against the DOM's own compareDocumentPosition API.
    expect(
      chatbotsGroup.compareDocumentPosition(settingsGroup) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
