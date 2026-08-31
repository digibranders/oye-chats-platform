import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { allowanceOf } from '../knowledge-model';
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
    discoveredTotal: null,
    maxPages: null,
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

vi.mock('../../../../services/api', () => ({
  getCurrentUser: () => Promise.resolve({ id: 1, website: null }),
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
          pageAllowance={allowanceOf(0, 100)}
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

describe('WebsiteFlow — what a finished crawl claims', () => {
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
