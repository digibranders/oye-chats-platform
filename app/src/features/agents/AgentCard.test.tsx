import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AgentCard } from './AgentCard';
import { agentHealth } from '../home/agentHealth';
import type { Bot } from '../../types/domain';
import type { AgentListItem } from './AgentsPage';

vi.mock('../../services/api', () => ({
  updateBot: vi.fn(),
  deleteBot: vi.fn(),
  trackDemoShareClick: vi.fn(),
  getBotDemoUrl: (key: string) => `https://demo.test/${key}`,
}));

function renderCard(bot: Partial<Bot>, conversations: number | null = 12) {
  const full: Bot = { id: 17, name: 'Support Concierge', ...bot };
  const item: AgentListItem = {
    bot: full,
    health: agentHealth(full),
    conversations,
    conversationsLoading: false,
  };
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ul>
          <AgentCard item={item} onChanged={vi.fn()} />
        </ul>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return full;
}

describe('AgentCard', () => {
  /**
   * The card the audit found put the "⋯" menu in an absolutely positioned
   * overlay on top of the tile's own click target, so the two controls fought
   * over the same pixels. The name is the link now, and the menu is its sibling.
   */
  it('keeps the actions menu outside the navigational link', () => {
    renderCard({ bot_key: 'bot-6a427d4529b9' });

    const link = screen.getByRole('link', { name: 'Support Concierge' });
    const menu = screen.getByRole('button', { name: 'Actions for Support Concierge' });

    expect(link).toHaveAttribute('href', '/chatbots/17/overview');
    expect(link).not.toContainElement(menu);
    expect(menu).not.toContainElement(link);
  });

  /** `bot_key` used to be an uncopyable masked caption below the tile. */
  it('renders the chatbot key as a real copy control', () => {
    renderCard({ bot_key: 'bot-6a427d4529b9' });

    expect(screen.getByText('bot-6a427d4529b9')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Copy chatbot key for Support Concierge' }),
    ).toBeInTheDocument();
  });

  it('says the key has not been issued rather than rendering a copy control over nothing', () => {
    renderCard({});

    expect(screen.getByText('Not issued yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /copy chatbot key/i })).not.toBeInTheDocument();
  });

  /** Absence is an em dash. A chatbot whose statistics failed is not a quiet one. */
  it('never renders an unknown figure as zero', () => {
    renderCard({ indexed_chunk_count: 0, last_crawl_status: 'failed' }, null);

    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    expect(screen.getByText('Nothing indexed')).toBeInTheDocument();
  });

  /** The one action on the card is the one the health verdict asks for. */
  it('offers the fix that this chatbot actually needs', () => {
    renderCard({ indexed_chunk_count: 0, last_crawl_status: 'failed' }, 0);

    expect(screen.getByRole('link', { name: 'Fix training' })).toHaveAttribute(
      'href',
      '/chatbots/17/knowledge',
    );
  });
});
