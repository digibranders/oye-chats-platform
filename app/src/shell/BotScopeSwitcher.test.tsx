import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BotScopeSwitcher } from './BotScopeSwitcher';
import { useBotContext } from '../context/BotContext';

/**
 * Which chatbot the WORKSPACE pages are showing.
 *
 * Distinct from `AgentSwitcher`, which navigates. Leads, Inbox, Journey and
 * Analytics read `BotContext.selectedBot`, so this one is a pure state write
 * and the URL is left alone. The legacy shell had exactly this control; the
 * redesign dropped it and never rebuilt it, leaving `selectBot` with no caller
 * — so `selectedBot` could only ever be null and those four pages were stuck
 * aggregating every chatbot with no way to narrow and nothing saying so.
 *
 * Hidden below two chatbots, and that is not an optimisation. Every plan except
 * Enterprise allows exactly ONE chatbot, so for almost every account there is
 * no choice to make and the control would be chrome that never does anything.
 */
vi.mock('../context/BotContext', () => ({ useBotContext: vi.fn() }));

const BOTS = [
  { id: 7, name: 'Support', bot_key: 'bot-aaa' },
  { id: 8, name: 'Sales', bot_key: 'bot-bbb' },
];

const selectBot = vi.fn();

function mount(over: Record<string, unknown> = {}) {
  vi.mocked(useBotContext).mockReturnValue({
    bots: BOTS,
    selectedBot: null,
    selectBot,
    loading: false,
    ...over,
  } as unknown as ReturnType<typeof useBotContext>);
  return render(
    <MemoryRouter>
      <BotScopeSwitcher />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  selectBot.mockReset();
});

describe('BotScopeSwitcher', () => {
  it('renders nothing for a single-chatbot account', () => {
    // The common case by a wide margin: every plan below Enterprise caps at one.
    const { container } = mount({ bots: [BOTS[0]] });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing while the chatbot list is still loading', () => {
    // A control that appears a beat late and shifts the rail under a reader is
    // worse than one that arrives with the page.
    const { container } = mount({ bots: [], loading: true });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for an account with no chatbots at all', () => {
    const { container } = mount({ bots: [] });
    expect(container).toBeEmptyDOMElement();
  });

  it('shows for an account that genuinely has a choice', () => {
    mount();
    expect(screen.getByRole('combobox', { name: /showing/i })).toBeInTheDocument();
  });

  it('says "all chatbots" when nothing is scoped', () => {
    mount({ selectedBot: null });
    expect(screen.getByRole('combobox', { name: /showing/i })).toHaveTextContent(/all chatbots/i);
  });

  it('names the chatbot when one is scoped', () => {
    mount({ selectedBot: BOTS[1] });
    expect(screen.getByRole('combobox', { name: /showing/i })).toHaveTextContent('Sales');
  });
});
