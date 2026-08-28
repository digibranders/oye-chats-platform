import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { allowanceOf } from '../knowledge-model';
import { WebsiteFlow } from './WebsiteFlow';

vi.mock('../../../../hooks/useEntitlements', () => ({
  useEntitlements: () => ({
    limitFor: (key: string) => (key === 'max_crawl_pages' ? 100 : key === 'max_crawl_depth' ? 3 : -1),
  }),
}));

vi.mock('../../../../context/CrawlContext', () => ({
  useCrawl: () => ({
    crawl: { status: 'idle', urls: [] },
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

describe('WebsiteFlow — crawl cap', () => {
  it('states the plan’s page and depth cap before a crawl starts', () => {
    renderFlow();
    expect(screen.getByText(/up to 100 pages, 3 levels deep/i)).toBeInTheDocument();
  });
});
