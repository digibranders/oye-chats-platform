import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { useOverviewData } from './overview-data';
import * as api from '../../../services/api';

vi.mock('../../../services/api', () => ({
  getDashboardStats: vi.fn(),
  getActivityStats: vi.fn(),
  getTopQuestions: vi.fn(),
  getBot: vi.fn(),
  getRatingsSummary: vi.fn(),
  getResolutionSummary: vi.fn(),
}));

describe('useOverviewData', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('parses present ratings and resolution summaries into AgentStats', async () => {
    vi.mocked(api.getDashboardStats).mockResolvedValue({
      total_conversations: 42,
      total_messages: 150,
      active_users: 10,
      success_rate: 85,
    });
    vi.mocked(api.getActivityStats).mockResolvedValue([]);
    vi.mocked(api.getTopQuestions).mockResolvedValue([]);
    vi.mocked(api.getBot).mockResolvedValue({ id: 17, name: 'Support Bot', brand_tone: 'Friendly' });
    vi.mocked(api.getRatingsSummary).mockResolvedValue({ avg: 4.8, total: 25 });
    vi.mocked(api.getResolutionSummary).mockResolvedValue({ rate: 92, total: 50 });

    const { result } = renderHook(() => useOverviewData(17));

    await waitFor(() => expect(result.current.status).toBe('success'));

    expect(result.current.stats).toEqual({
      totalConversations: 42,
      totalMessages: 150,
      activeUsers: 10,
      successRate: 85,
      resolutionRate: 92,
      averageRating: 4.8,
    });
    expect(result.current.details).toEqual({ id: 17, name: 'Support Bot', brand_tone: 'Friendly' });
  });

  it('keeps null for unavailable ratings and resolution rather than coercing to zero', async () => {
    vi.mocked(api.getDashboardStats).mockResolvedValue({
      total_conversations: 5,
      total_messages: 12,
      active_users: 2,
    });
    vi.mocked(api.getActivityStats).mockResolvedValue([]);
    vi.mocked(api.getTopQuestions).mockResolvedValue([]);
    vi.mocked(api.getBot).mockRejectedValue(new Error('Bot details failed'));
    vi.mocked(api.getRatingsSummary).mockResolvedValue({});
    vi.mocked(api.getResolutionSummary).mockResolvedValue({});

    const { result } = renderHook(() => useOverviewData(17));

    await waitFor(() => expect(result.current.status).toBe('success'));

    expect(result.current.stats).toMatchObject({
      resolutionRate: null,
      averageRating: null,
    });
    expect(result.current.details).toBeNull();
  });

  it('sets status to error when primary dashboard request fails', async () => {
    vi.mocked(api.getDashboardStats).mockRejectedValue(new Error('Network error'));
    vi.mocked(api.getActivityStats).mockResolvedValue([]);
    vi.mocked(api.getTopQuestions).mockResolvedValue([]);
    vi.mocked(api.getBot).mockResolvedValue({ id: 17, name: 'Bot' });
    vi.mocked(api.getRatingsSummary).mockResolvedValue({});
    vi.mocked(api.getResolutionSummary).mockResolvedValue({});

    const { result } = renderHook(() => useOverviewData(17));

    await waitFor(() => expect(result.current.status).toBe('error'));

    expect(result.current.stats).toBeNull();
    expect(result.current.error).toBe('Network error');
  });

  it('preserves successful dashboard result when activity or questions request fails', async () => {
    vi.mocked(api.getDashboardStats).mockResolvedValue({ total_conversations: 10 });
    vi.mocked(api.getActivityStats).mockRejectedValue(new Error('Activity failed'));
    vi.mocked(api.getTopQuestions).mockRejectedValue(new Error('Questions failed'));
    vi.mocked(api.getBot).mockResolvedValue({ id: 17, name: 'Bot' });
    vi.mocked(api.getRatingsSummary).mockResolvedValue({});
    vi.mocked(api.getResolutionSummary).mockResolvedValue({});

    const { result } = renderHook(() => useOverviewData(17));

    await waitFor(() => expect(result.current.status).toBe('success'));

    expect(result.current.stats).not.toBeNull();
    expect(result.current.activity).toEqual([]);
    expect(result.current.questions).toEqual([]);
  });
});
