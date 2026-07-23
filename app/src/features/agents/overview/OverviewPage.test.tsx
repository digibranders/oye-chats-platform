import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { OverviewPage } from './OverviewPage';
import { useAgent } from '../../../context/AgentContext';
import { useOverviewData } from './overview-data';
import { type Bot } from '../../../types/domain';

vi.mock('../../../context/AgentContext', () => ({
  useAgent: vi.fn(),
}));

vi.mock('./overview-data', () => ({
  useOverviewData: vi.fn(),
}));

describe('OverviewPage', () => {
  const mockBot: Bot = {
    id: 17,
    name: 'Support Concierge',
    bot_key: 'bot-1234567890',
    website: 'https://example.com',
    widget_installed_at: '2026-07-01T00:00:00Z',
    crawl_completed_at: '2026-07-01T00:00:00Z',
    last_crawl_status: 'completed',
    indexed_chunk_count: 42,
    created_at: '2026-07-12T00:00:00.000Z',
  };

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('renders skeleton when agent context is loading', () => {
    vi.mocked(useAgent).mockReturnValue({
      agent: null,
      agentId: '17',
      loading: true,
      error: null,
      refresh: vi.fn(),
    });

    render(
      <MemoryRouter>
        <OverviewPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { level: 1, name: 'Overview' })).toBeInTheDocument();
  });

  it('renders mission control content when agent and stats are loaded', () => {
    vi.mocked(useAgent).mockReturnValue({
      agent: mockBot,
      agentId: '17',
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    vi.mocked(useOverviewData).mockReturnValue({
      status: 'success',
      isRefetching: false,
      stats: {
        totalConversations: 100,
        totalMessages: 500,
        activeUsers: 50,
        successRate: 90,
        resolutionRate: 85,
        averageRating: 4.7,
      },
      activity: [],
      questions: [],
      details: mockBot,
      error: null,
      refetch: vi.fn(),
    });

    render(
      <MemoryRouter>
        <OverviewPage />
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { level: 1, name: 'Support Concierge' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /manage knowledge/i })).toHaveAttribute(
      'href',
      '/agents/17/knowledge',
    );
  });

  it('renders MetricsError and retry surface on metrics error', () => {
    const mockRefetch = vi.fn();
    vi.mocked(useAgent).mockReturnValue({
      agent: mockBot,
      agentId: '17',
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    vi.mocked(useOverviewData).mockReturnValue({
      status: 'error',
      isRefetching: false,
      stats: null,
      activity: [],
      questions: [],
      details: null,
      error: 'Failed to load metrics',
      refetch: mockRefetch,
    });

    render(
      <MemoryRouter>
        <OverviewPage />
      </MemoryRouter>,
    );

    expect(screen.getByText('Couldn’t load your metrics')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('renders dashes for unavailable metrics without crashing', () => {
    vi.mocked(useAgent).mockReturnValue({
      agent: mockBot,
      agentId: '17',
      loading: false,
      error: null,
      refresh: vi.fn(),
    });

    vi.mocked(useOverviewData).mockReturnValue({
      status: 'success',
      isRefetching: false,
      stats: {
        totalConversations: 0,
        totalMessages: 0,
        activeUsers: 0,
        successRate: 0,
        resolutionRate: null,
        averageRating: null,
      },
      activity: [],
      questions: [],
      details: null,
      error: null,
      refetch: vi.fn(),
    });

    render(
      <MemoryRouter>
        <OverviewPage />
      </MemoryRouter>,
    );

    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });
});
