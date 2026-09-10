import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FeedbackPanel } from './FeedbackPanel';
import { resolveRange } from '../analytics/range';
import {
  getFeedbackData,
  getOperatorRatedChats,
  getOperatorRatings,
  getRatingsSummary,
  readerTimeZone,
} from '../../services/api';
import { downloadCsv } from '../../lib/downloadCsv';
import { defaultReportMonth } from './operator-report';
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
  getRatingsSummary: vi.fn(),
  getOperatorRatings: vi.fn(),
  getOperatorRatedChats: vi.fn(),
  readerTimeZone: vi.fn(),
}));

// A real download needs a document that can navigate. What these tests care
// about is the file's CONTENTS, so the last hop is replaced with a recorder.
vi.mock('../../lib/downloadCsv', () => ({ downloadCsv: vi.fn() }));

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
  // The live-support card is not what most of these tests are about, so it is
  // given a quiet default: no ratings, no operators. Tests that DO exercise it
  // override these.
  vi.mocked(getRatingsSummary).mockResolvedValue({ average: null, total: 0, breakdown: {} });
  vi.mocked(getOperatorRatings).mockResolvedValue([]);
  vi.mocked(readerTimeZone).mockReturnValue('Asia/Kolkata');
  vi.mocked(getOperatorRatedChats).mockResolvedValue({ items: [], total: 0, unrated: 0 });
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


/**
 * The per-operator breakdown inside the live-support card.
 *
 * Two things here are easy to get wrong in ways no diff shows. The first is
 * that an average without its count reads as a verdict: 2.0 from a single chat
 * looks identical to 2.0 from fifty, and this list is about named people. The
 * second is that operator names are NOT unique — a workspace can hold two
 * seats with the same display name, and a list that prints it twice is a
 * ranking the reader cannot act on.
 */
describe('FeedbackPanel — the per-operator breakdown', () => {
  const opRow = (over: Record<string, unknown> = {}) => ({
    operator_id: 1,
    name: 'Ana',
    email: 'ana@example.com',
    total: 6,
    avg: 4.5,
    unhappy: 0,
    ...over,
  });

  function withRatings() {
    vi.mocked(getFeedbackData).mockResolvedValue([item()]);
    vi.mocked(getRatingsSummary).mockResolvedValue({
      average: 4.2,
      total: 9,
      breakdown: { '5': 5, '4': 3, '3': 1, '2': 0, '1': 0 },
    });
  }

  it('shows each operator with the rating count beside the average', async () => {
    withRatings();
    vi.mocked(getOperatorRatings).mockResolvedValue([
      opRow({ operator_id: 1, name: 'Ana', total: 6, avg: 4.5 }),
      opRow({ operator_id: 2, name: 'Bo', email: 'bo@example.com', total: 8, avg: 3.1, unhappy: 2 }),
    ]);
    renderPanel();

    await screen.findByText('By operator');
    expect(screen.getByText('Ana')).toBeInTheDocument();
    expect(screen.getByText('4.5 / 5')).toBeInTheDocument();
    expect(screen.getByText('6 rated')).toBeInTheDocument();
    expect(screen.getByText('2 unhappy')).toBeInTheDocument();
  });

  it('adds the email only when two operators share a display name', async () => {
    withRatings();
    vi.mocked(getOperatorRatings).mockResolvedValue([
      opRow({ operator_id: 1, name: 'Sam Rae', email: 'sam@example.com' }),
      opRow({ operator_id: 2, name: 'Sam Rae', email: 'sam.rae@example.com', avg: 3.9 }),
      opRow({ operator_id: 3, name: 'Ana', email: 'ana@example.com', avg: 3.2 }),
    ]);
    renderPanel();

    await screen.findByText('By operator');
    expect(screen.getByText('sam@example.com')).toBeInTheDocument();
    expect(screen.getByText('sam.rae@example.com')).toBeInTheDocument();
    // Ana is already unambiguous, so her row stays a name and nothing else.
    expect(screen.queryByText('ana@example.com')).not.toBeInTheDocument();
  });

  it('falls back to the seat id when the same person holds two seats', async () => {
    // A real case: one person added to the workspace twice. The email repeats,
    // so it cannot separate the rows and the id has to.
    withRatings();
    vi.mocked(getOperatorRatings).mockResolvedValue([
      opRow({ operator_id: 238, name: 'Sam Rae', email: 'sam@example.com' }),
      opRow({ operator_id: 228, name: 'Sam Rae', email: 'sam@example.com', avg: 3.5 }),
    ]);
    renderPanel();

    await screen.findByText('By operator');
    expect(screen.getByText('#238')).toBeInTheDocument();
    expect(screen.getByText('#228')).toBeInTheDocument();
  });

  it('says so when an average rests on too few ratings to mean anything', async () => {
    withRatings();
    vi.mocked(getOperatorRatings).mockResolvedValue([opRow({ total: 2, avg: 2.0 })]);
    renderPanel();

    await screen.findByText('By operator');
    expect(screen.getByText(/too small a sample to judge anyone by/i)).toBeInTheDocument();
  });

  it('omits the section entirely for someone the endpoint refuses', async () => {
    // A plain operator gets a 403. That is an answer, not a failure: the
    // section disappears rather than showing them an error about data they
    // were never meant to see.
    withRatings();
    vi.mocked(getOperatorRatings).mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    renderPanel();

    await screen.findByText('How did the team do?');
    await waitFor(() => {
      expect(screen.queryByText('By operator')).not.toBeInTheDocument();
    });
    expect(screen.queryByText(/Failed to load operator ratings/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download report' })).not.toBeInTheDocument();
  });
});

/**
 * The monthly report download.
 *
 * What goes wrong here is invisible on screen: the file is cut on the wrong
 * calendar, leaves out the operator nobody rated, or saves an empty sheet that
 * looks like a broken export. Each test pins one of those.
 */
describe('FeedbackPanel: the monthly operator report', () => {
  const reportRow = (over: Record<string, unknown> = {}) => ({
    operator_id: 1,
    name: 'Ana',
    email: 'ana@example.com',
    handled: 12,
    total: 6,
    avg: 4.5,
    unhappy: 1,
    stars: { '5': 4, '4': 1, '3': 0, '2': 1, '1': 0 },
    ...over,
  });

  function withLiveRatings() {
    vi.mocked(getFeedbackData).mockResolvedValue([item()]);
    vi.mocked(getRatingsSummary).mockResolvedValue({
      average: 4.2,
      total: 9,
      breakdown: { '5': 5, '4': 3, '3': 1, '2': 0, '1': 0 },
    });
  }

  it('downloads the last full month in the reader zone, including operators nobody rated', async () => {
    withLiveRatings();
    vi.mocked(getOperatorRatings).mockImplementation(async (_botId, _days, options) =>
      options?.month
        ? [
            reportRow(),
            reportRow({
              operator_id: 2,
              name: 'Bo',
              email: 'bo@example.com',
              handled: 3,
              total: 0,
              avg: null,
              unhappy: 0,
              stars: {},
            }),
          ]
        : [reportRow()],
    );
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'Download report' }));

    const month = defaultReportMonth(new Date());
    await waitFor(() => expect(downloadCsv).toHaveBeenCalledTimes(1));
    expect(getOperatorRatings).toHaveBeenCalledWith(7, null, {
      month,
      tz: 'Asia/Kolkata',
      minRatings: 0,
    });
    const [csv, filename] = vi.mocked(downloadCsv).mock.calls[0];
    expect(filename).toBe(`oyechats-operator-ratings-${month}.csv`);
    const [header, ana, bo] = csv.split('\n');
    expect(header).toContain('"Chats handled","Chats rated","Average rating"');
    expect(ana).toBe('"1","Ana","ana@example.com","12","6","4.5","4","1","0","1","0","1"');
    expect(bo).toBe('"2","Bo","bo@example.com","3","0","","0","0","0","0","0","0"');
    expect(await screen.findByText(/Downloaded .+: 2 operators\./)).toBeInTheDocument();
  });

  it('says there is nothing to download instead of saving an empty sheet', async () => {
    withLiveRatings();
    vi.mocked(getOperatorRatings).mockImplementation(async (_botId, _days, options) =>
      options?.month ? [] : [reportRow()],
    );
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'Download report' }));

    expect(await screen.findByText(/nothing to download/i)).toBeInTheDocument();
    expect(downloadCsv).not.toHaveBeenCalled();
  });

  it('keeps the download available when the page period has nobody to rank', async () => {
    // A quiet fortnight on screen says nothing about last month, which is the
    // file a manager comes for.
    withLiveRatings();
    vi.mocked(getOperatorRatings).mockResolvedValue([]);
    renderPanel();

    expect(await screen.findByText('No operator has been rated in this period yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download report' })).toBeEnabled();
  });

  it('reports a failed download in words rather than silence', async () => {
    withLiveRatings();
    vi.mocked(getOperatorRatings).mockImplementation(async (_botId, _days, options) => {
      if (options?.month) throw new Error('network down');
      return [reportRow()];
    });
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: 'Download report' }));

    expect(await screen.findByText(/could not prepare the report|network down/i)).toBeInTheDocument();
    expect(downloadCsv).not.toHaveBeenCalled();
  });
});

/**
 * The drill-down under each operator row.
 *
 * Pinned: nothing is fetched until someone opens a row, the list keeps the
 * server's worst-first order, every row links to a conversation that can
 * actually open, and a visitor who never left a name is not shown as a blank.
 */
describe('FeedbackPanel: the chats behind an operator', () => {
  const LIST_NAME = 'Rated chats, lowest rating first';

  function withOperator() {
    vi.mocked(getFeedbackData).mockResolvedValue([item()]);
    vi.mocked(getRatingsSummary).mockResolvedValue({
      average: 4.2,
      total: 9,
      breakdown: { '5': 5, '4': 3, '3': 1, '2': 0, '1': 0 },
    });
    vi.mocked(getOperatorRatings).mockResolvedValue([
      { operator_id: 1, name: 'Ana', email: 'ana@example.com', handled: 9, total: 6, avg: 4.5, unhappy: 1 },
    ]);
  }

  it('fetches nothing until the row is opened, then lists the chats worst first', async () => {
    withOperator();
    vi.mocked(getOperatorRatedChats).mockResolvedValue({
      items: [
        {
          session_id: 's-1',
          rating: 1,
          created_at: '2026-08-28T10:00:00Z',
          visitor_name: 'Priya Sharma',
          visitor_email: 'priya@acme.in',
        },
        { session_id: 's-2', rating: 5, created_at: '2026-08-24T10:00:00Z', visitor_name: null, visitor_email: null },
      ],
      total: 2,
      unrated: 3,
    });
    renderPanel();

    const toggle = await screen.findByRole('button', { name: /^Ana/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(getOperatorRatedChats).not.toHaveBeenCalled();

    await userEvent.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(getOperatorRatedChats).toHaveBeenCalledWith(1, 7, 30, { limit: 20, offset: 0 });
    const list = await screen.findByRole('list', { name: LIST_NAME });
    const rows = within(list).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('1 star');
    expect(rows[0]).toHaveTextContent('Priya Sharma');
    expect(rows[1]).toHaveTextContent('Anonymous visitor');
    expect(within(rows[0]).getByRole('link', { name: 'View chat with Priya Sharma' })).toHaveAttribute(
      'href',
      '/leads?lead=s-1',
    );
    expect(screen.getByText("Plus 3 chats that weren't rated.")).toBeInTheDocument();
  });

  it('pages twenty at a time', async () => {
    withOperator();
    vi.mocked(getOperatorRatedChats).mockImplementation(async (_operatorId, _botId, _days, page) => {
      const offset = page?.offset ?? 0;
      const count = offset === 0 ? 20 : 3;
      return {
        items: Array.from({ length: count }, (_, i) => ({
          session_id: `s-${offset + i}`,
          rating: 3,
          created_at: '2026-08-20T10:00:00Z',
          visitor_name: `Visitor ${offset + i}`,
          visitor_email: null,
        })),
        total: 23,
        unrated: 0,
      };
    });
    renderPanel();

    await userEvent.click(await screen.findByRole('button', { name: /^Ana/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Show more (3 left)' }));

    expect(getOperatorRatedChats).toHaveBeenLastCalledWith(1, 7, 30, { limit: 20, offset: 20 });
    const list = screen.getByRole('list', { name: LIST_NAME });
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(23));
    expect(screen.queryByRole('button', { name: /Show more/ })).not.toBeInTheDocument();
  });

  it('says so when the chats cannot be loaded, without collapsing the row', async () => {
    withOperator();
    vi.mocked(getOperatorRatedChats).mockRejectedValue(new Error('network down'));
    renderPanel();

    const toggle = await screen.findByRole('button', { name: /^Ana/ });
    await userEvent.click(toggle);

    expect(await screen.findByText('Chats could not be loaded')).toBeInTheDocument();
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });
});
