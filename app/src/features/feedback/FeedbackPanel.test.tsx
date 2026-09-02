import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FeedbackPanel } from './FeedbackPanel';
import { resolveRange } from '../analytics/range';
import { getFeedbackData } from '../../services/api';
import type { FeedbackItem } from './types';

/**
 * The panel's contract with the page it sits in.
 *
 * The thing worth pinning is not how it looks: it is that the window comes from
 * Analytics and is not re-decided here. This panel used to own a private
 * 7d/30d/All control, so the page header could read "Last 90 days" over a card
 * counting a fortnight — a disagreement that is invisible in either component's
 * own diff and only exists at the seam. The rest of these cover the four states,
 * which is the other thing a reader cannot tell apart by looking at a blank
 * panel.
 */

vi.mock('../../services/api', () => ({
  getFeedbackData: vi.fn(),
}));

const DAY_MS = 86_400_000;

function item(overrides: Partial<FeedbackItem> = {}): FeedbackItem {
  return {
    message_id: 1,
    created_at: new Date(Date.now() - DAY_MS).toISOString(),
    question: 'How much does it cost?',
    answer: 'Plans start at 999 INR.',
    feedback: 1,
    user: 'User -3',
    ...overrides,
  };
}

function renderPanel(rangeKey: '7d' | '30d' | '90d' | 'all' = '30d', botId: number | null = 7) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <FeedbackPanel botId={botId} range={resolveRange(rangeKey)} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  // Two browser APIs jsdom does not implement, both used by click-to-jump: the
  // scroll itself, and the reduced-motion query that decides whether it
  // animates. Missing environment, not a missing guard — the component is right
  // to call them straight.
  if (!HTMLElement.prototype.scrollIntoView) {
    HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
  }
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
});

describe('FeedbackPanel — the window belongs to the page', () => {
  it('offers no date control of its own', async () => {
    vi.mocked(getFeedbackData).mockResolvedValue([item()]);
    renderPanel('30d');

    await screen.findByText('How much does it cost?');
    // The only radiogroup left is the All / Helpful / Not helpful filter. A
    // second one here would be the competing time vocabulary coming back.
    const groups = screen.getAllByRole('radiogroup');
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveAccessibleName('Filter rated answers');
  });

  it('counts only the ratings inside the range it was given', async () => {
    vi.mocked(getFeedbackData).mockResolvedValue([
      item({ message_id: 1, created_at: new Date(Date.now() - 2 * DAY_MS).toISOString() }),
      item({ message_id: 2, created_at: new Date(Date.now() - 45 * DAY_MS).toISOString() }),
    ]);
    renderPanel('7d');

    await screen.findByText('How much does it cost?');
    const filter = screen.getByRole('radiogroup', { name: 'Filter rated answers' });
    expect(within(filter).getByRole('radio', { name: /All/ })).toHaveTextContent('1');
  });

  it('names the page’s period rather than a period of its own', async () => {
    vi.mocked(getFeedbackData).mockResolvedValue([item()]);
    renderPanel('90d');

    expect(await screen.findAllByText(/last 90 days/i)).not.toHaveLength(0);
  });
});

describe('FeedbackPanel — the four states', () => {
  it('shows a loading placeholder while the ratings are in flight', () => {
    vi.mocked(getFeedbackData).mockReturnValue(new Promise(() => {}));
    const { container } = renderPanel();

    expect(container.querySelector('[aria-busy]')).not.toBeNull();
  });

  it('distinguishes "never rated" from "nothing in this window"', async () => {
    vi.mocked(getFeedbackData).mockResolvedValue([]);
    const { unmount } = renderPanel();
    expect(await screen.findByText('No answers rated yet')).toBeInTheDocument();
    unmount();

    vi.mocked(getFeedbackData).mockResolvedValue([
      item({ created_at: new Date(Date.now() - 200 * DAY_MS).toISOString() }),
    ]);
    renderPanel('7d');
    expect(await screen.findByText('Nothing rated in this period')).toBeInTheDocument();
  });

  it('explains a failure in the user’s terms and offers the way back', async () => {
    vi.mocked(getFeedbackData).mockRejectedValue(new Error('Failed to load feedback'));
    renderPanel();

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Ratings could not be loaded')).toBeInTheDocument();

    vi.mocked(getFeedbackData).mockResolvedValue([item()]);
    await userEvent.click(within(alert).getByRole('button', { name: /try again/i }));
    await screen.findByText('How much does it cost?');
  });

  it('calls a refusal what it is, rather than inventing a plan gate', async () => {
    /* `/analytics/feedback` carries no entitlement check — it answers, 404s on
       an unowned chatbot, or 500s. A lock here would name a tier that gates
       nothing and put a wall in front of data the customer already has. */
    vi.mocked(getFeedbackData).mockRejectedValue(
      Object.assign(new Error('Forbidden'), { status: 403 }),
    );
    renderPanel();

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Ratings could not be loaded')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /see plans/i })).toBeNull();
  });
});

describe('FeedbackPanel — reading the numbers without the picture', () => {
  it('states the trend in words beside the chart', async () => {
    vi.mocked(getFeedbackData).mockResolvedValue([
      item({ message_id: 1, created_at: new Date(Date.now() - 2 * DAY_MS).toISOString() }),
      item({
        message_id: 2,
        feedback: -1,
        created_at: new Date(Date.now() - DAY_MS).toISOString(),
      }),
    ]);
    renderPanel('30d');

    // It used to claim "by day, over last 30 days", which the chart cannot do:
    // `buildTrend` plots only the days that carry a rating and stops at the
    // most recent fourteen. Two rated days in a thirty-day window draw two
    // points, and the sentence beside them now says exactly that.
    expect(
      await screen.findByText(
        /share of answers rated helpful, drawn from last 30 days, on the 2 most recent days in it that carry a rating/i,
      ),
    ).toBeInTheDocument();
  });

  it('jumps from a ranked question to the exchange behind it', async () => {
    const user = userEvent.setup();
    vi.mocked(getFeedbackData).mockResolvedValue([
      item({ message_id: 1, feedback: -1, question: 'Do you integrate with Slack?' }),
      item({ message_id: 2, feedback: 1, question: 'How much does it cost?' }),
    ]);
    renderPanel();

    const ranked = await screen.findByRole('list', {
      name: 'Most frequently unhelpful questions',
    });
    await user.click(within(ranked).getByRole('button', { name: /Do you integrate with Slack/ }));

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: /Do you integrate with Slack/, expanded: true }),
      ).toBeInTheDocument();
    });
    // Switched to the unhelpful ones, because the match is always a negative.
    expect(screen.getByRole('radio', { name: /Not helpful/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });
});
