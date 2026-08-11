import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { AgentSnapshotCards } from './AgentSnapshotCards';
import { type Bot } from '../../../types/domain';
import { type AgentStats } from './overview-data';

describe('AgentSnapshotCards', () => {
  const sampleAgent: Bot = {
    id: 17,
    name: 'Support Concierge',
    bot_key: 'bot-1234567890',
    website: 'https://example.com',
    widget_installed_at: '2026-07-01T00:00:00Z',
    crawl_completed_at: '2026-07-01T00:00:00Z',
    last_crawl_status: 'completed',
    indexed_chunk_count: 42,
    created_at: '2026-07-12T00:00:00.000Z',
    brand_tone: 'Warm & Professional',
  };

  const sampleStats: AgentStats = {
    totalConversations: 100,
    totalMessages: 500,
    activeUsers: 50,
    successRate: 90,
    resolutionRate: 88,
    averageRating: 4.6,
  };

  it('renders AgentSnapshotCards with deep links and metrics', () => {
    render(
      <MemoryRouter>
        <AgentSnapshotCards
          agent={sampleAgent}
          details={sampleAgent}
          stats={sampleStats}
          activity={[]}
          agentBasePath="/agents/17"
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: /manage knowledge/i })).toHaveAttribute(
      'href',
      '/agents/17/knowledge',
    );
    expect(screen.getByRole('link', { name: /manage channels/i })).toHaveAttribute(
      'href',
      '/agents/17/channels',
    );
    expect(screen.getByRole('link', { name: /configure experience/i })).toHaveAttribute(
      'href',
      '/agents/17/experience',
    );
    expect(screen.getByRole('link', { name: /view analytics/i })).toHaveAttribute(
      'href',
      '/agents/17/analytics',
    );

    expect(screen.getByText('42 passages')).toBeInTheDocument();
    expect(screen.getByText('Warm & Professional')).toBeInTheDocument();
    expect(screen.getByText('88%')).toBeInTheDocument();
    expect(screen.getByText('4.6 / 5')).toBeInTheDocument();
  });

  it('renders dash and explanation when resolution or rating metrics are missing', () => {
    const emptyStats: AgentStats = {
      totalConversations: 0,
      totalMessages: 0,
      activeUsers: 0,
      successRate: 0,
      resolutionRate: null,
      averageRating: null,
    };

    render(
      <MemoryRouter>
        <AgentSnapshotCards
          agent={sampleAgent}
          details={null}
          stats={emptyStats}
          activity={[]}
          agentBasePath="/agents/17"
        />
      </MemoryRouter>,
    );

    const dashes = screen.getAllByText('-');
    expect(dashes.length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/no ratings yet/i)).toBeInTheDocument();
    expect(screen.getByText(/no resolved conversations yet/i)).toBeInTheDocument();
  });

  it('handles uninstalled widget and training status correctly', () => {
    const uninstalledAgent: Bot = {
      ...sampleAgent,
      widget_installed_at: null,
      last_crawl_status: 'running',
    };

    render(
      <MemoryRouter>
        <AgentSnapshotCards
          agent={uninstalledAgent}
          details={null}
          stats={sampleStats}
          activity={[]}
          agentBasePath="/agents/17"
        />
      </MemoryRouter>,
    );

    expect(screen.getByText('Not installed')).toBeInTheDocument();
    expect(screen.getByText('Training now')).toBeInTheDocument();
  });
});
