import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WebsiteFlow } from './WebsiteFlow';

const state = vi.hoisted(() => ({
  crawl: {
    status: 'idle' as string,
    urls: [] as string[],
    pagesCrawled: 0,
    botId: null as number | null,
    result: null as unknown,
    error: null as string | null,
    currentUrl: null,
    // The two progress denominators, in the order the UI prefers them: the page
    // set the crawl was actually handed, then the plan's own ceiling.
    discoveredTotal: null as number | null,
    maxPages: null as number | null,
    cancelInFlight: false,
  },
}));

vi.mock('../../../../hooks/useEntitlements', () => ({
  useEntitlements: () => ({
    limitFor: (key: string) => (key === 'max_crawl_pages' ? 100 : key === 'max_crawl_depth' ? 3 : -1),
  }),
}));

vi.mock('../../../../context/CrawlContext', () => ({
  useCrawl: () => ({
    crawl: state.crawl,
    startCrawl: vi.fn(),
    cancelCrawl: vi.fn(),
    isOurCrawl: () => false,
  }),
}));

const api = vi.hoisted(() => ({ discoverCrawlUrls: vi.fn() }));
vi.mock('../../../../services/api', () => ({
  getCurrentUser: () => Promise.resolve({ id: 1, website: null }),
  discoverCrawlUrls: api.discoverCrawlUrls,
}));

function renderFlow() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <WebsiteFlow
          agentId={1}
          agentName="Test Bot"
          agentWebsite={null}
          sources={[]}
          pagesTrainedHere={0}
          pageLimit={100}
          planName="Starter"
          planLoading={false}
          onChanged={() => {}}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  state.crawl = {
    status: 'idle',
    urls: [],
    pagesCrawled: 0,
    botId: null,
    result: null,
    error: null,
    currentUrl: null,
    discoveredTotal: null,
    maxPages: null,
    cancelInFlight: false,
  };
});

describe('WebsiteFlow — crawl cap', () => {
  it('states the plan’s page and depth cap before a crawl starts', () => {
    renderFlow();
    expect(screen.getByText(/up to 100 pages, 3 levels deep/i)).toBeInTheDocument();
  });
});

describe('WebsiteFlow: progress while a crawl runs', () => {
  /**
   * `crawl.maxPages` is the server's `effective_max_pages`, which on an
   * unlimited plan is `balance / cost_per_page`. Re-training a 47-page site
   * reported "3 of 9,800 pages" against it, with the bar pinned near 0%,
   * because the re-train path never sent the `discoveredTotal` the fresh-crawl
   * path has always sent.
   */
  it('counts against the pages it was actually given, not the credit ceiling', () => {
    state.crawl = {
      ...state.crawl,
      status: 'running',
      botId: 1,
      pagesCrawled: 3,
      discoveredTotal: 47,
      maxPages: 9800,
    };
    renderFlow();

    expect(screen.getByText('3 of 47 pages')).toBeInTheDocument();
    expect(screen.queryByText(/9,800/)).not.toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '6');
  });

  it('falls back to the plan ceiling only when no page set was sent', () => {
    state.crawl = {
      ...state.crawl,
      status: 'running',
      botId: 1,
      pagesCrawled: 3,
      discoveredTotal: null,
      maxPages: 9800,
    };
    renderFlow();

    expect(screen.getByText('3 of 9,800 pages')).toBeInTheDocument();
  });
});

describe('WebsiteFlow: what a finished crawl claims', () => {
  it('does not claim 400 pages were read when 25 were indexed', () => {
    // The binding cap is characters, not pages (Starter: 50,000), so a
    // 400-page crawl stops around page 25 and the run still ends `done`.
    // `pagesCrawled` is the FETCHED count and reported all 400 as success.
    state.crawl = {
      ...state.crawl,
      status: 'done',
      botId: 1,
      pagesCrawled: 400,
      result: {
        pages_processed: 400,
        pages_ingested: 25,
        pages_failed: 0,
        pages_discovered: 400,
        pages_dropped: 0,
        aborted: true,
        abort_reason: 'knowledge_quota',
      },
    };
    renderFlow();

    expect(screen.queryByText(/read 400 pages/i)).toBeNull();
    expect(screen.getByText(/25 pages of the 400/)).toBeInTheDocument();
    // And what to do about it — the reason distinguishes a full knowledge base
    // from an empty credit balance, and they have different answers.
    expect(screen.getByText(/knowledge base is full/i)).toBeInTheDocument();
  });

  it('still congratulates a crawl that covered the site', () => {
    state.crawl = {
      ...state.crawl,
      status: 'done',
      botId: 1,
      pagesCrawled: 42,
      result: { pages_processed: 42, pages_ingested: 42, aborted: false, abort_reason: null },
    };
    renderFlow();

    expect(screen.getByText('Finished — this chatbot read 42 pages.')).toBeInTheDocument();
  });

  it('falls back to the fetched count while the result payload is still in flight', () => {
    // The terminal status arrives before the payload; a blank or zeroed banner
    // in that window would be worse than the count we already have.
    state.crawl = { ...state.crawl, status: 'done', botId: 1, pagesCrawled: 7, result: null };
    renderFlow();

    expect(screen.getByText('Finished — this chatbot read 7 pages.')).toBeInTheDocument();
  });
});

describe('when the page count fails', () => {
  it('invents no numbers and still offers to train', async () => {
    /* The failure path used to store a synthetic `{ total_found: 0 }`, which the
       budget model padded into "balance 0 · 1 credits a page" for an account with
       thousands of credits, beside a disabled "Train on 0 pages". A timeout is
       exactly when a site is large, and large is exactly when the invented
       numbers are most wrong. */
    api.discoverCrawlUrls.mockRejectedValue(new Error('timeout of 30000ms exceeded'));
    renderFlow();

    const address = screen.getByRole('textbox');
    fireEvent.change(address, { target: { value: 'https://www.example.test' } });
    fireEvent.click(screen.getByRole('button', { name: /check pages/i }));

    await waitFor(() => expect(api.discoverCrawlUrls).toHaveBeenCalled());
    const train = await screen.findByRole('button', { name: /train anyway/i });
    expect(train).toBeEnabled();
    expect(screen.queryByText(/balance 0/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/1 credits a page/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /train on 0 pages/i })).not.toBeInTheDocument();
  });
});
