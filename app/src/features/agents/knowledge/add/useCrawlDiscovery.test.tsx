import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCrawlDiscovery } from './useCrawlDiscovery';

/**
 * Which crawl the backend is asked to run.
 *
 * Sending `ordered_urls` puts the backend on its `fetch_urls` branch, which
 * fetches exactly the list it was handed. Omitting it runs `crawl_website`,
 * which is the only path to sitemap discovery, link following and the
 * recursive crawl. That choice is made here, off one boolean, and it was
 * structurally always "fetch this list" — server-side discovery guarantees at
 * least the seed URL, so a client-rendered SPA with no sitemap was crawled as
 * exactly its homepage and told to turn on JavaScript.
 */

const api = vi.hoisted(() => ({
  discoverCrawlUrls: vi.fn(),
  getCurrentUser: vi.fn(),
}));
const crawl = vi.hoisted(() => ({ startCrawl: vi.fn(), cancelCrawl: vi.fn() }));

vi.mock('../../../../services/api', () => api);

vi.mock('../../../../hooks/useEntitlements', () => ({
  useEntitlements: () => ({ planSlug: 'starter' }),
}));

vi.mock('../../../../context/CrawlContext', () => ({
  useCrawl: () => ({
    crawl: { status: 'idle', urls: [], pagesCrawled: 0, botId: null, result: null, error: null },
    startCrawl: crawl.startCrawl,
    cancelCrawl: crawl.cancelCrawl,
  }),
}));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function mount() {
  return renderHook(
    () =>
      useCrawlDiscovery({
        agentId: 1,
        agentName: 'Test Bot',
        agentWebsite: 'https://spa.example',
        sources: [],
        onChanged: () => {},
      }),
    { wrapper },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getCurrentUser.mockResolvedValue({ id: 1, website: null });
  crawl.startCrawl.mockResolvedValue({});
});

describe('useCrawlDiscovery — which crawl gets run', () => {
  it('lets the backend crawl a site whose discovery found only the seed URL', async () => {
    api.discoverCrawlUrls.mockResolvedValue({
      total_found: 1,
      capped: false,
      urls: ['https://spa.example/'],
    });

    const { result } = mount();
    await waitFor(() => expect(result.current.url).toBe('https://spa.example'));
    await act(async () => {
      await result.current.discover();
    });

    // One URL is not a page list — it is the address we were given back.
    expect(result.current.hasPageList).toBe(false);
    // …so the footer's count comes from the server's own total rather than
    // from a selection of one.
    expect(result.current.pageCount).toBe(1);

    await act(async () => {
      await result.current.beginCrawl();
    });

    const options = crawl.startCrawl.mock.calls[0]?.[0];
    expect(options).toBeDefined();
    expect(options.orderedUrls).toBeUndefined();
  });

  it('still hands over a real page list when the customer has one to pick from', async () => {
    api.discoverCrawlUrls.mockResolvedValue({
      total_found: 3,
      capped: false,
      urls: ['https://spa.example/', 'https://spa.example/pricing', 'https://spa.example/docs'],
    });

    const { result } = mount();
    await act(async () => {
      await result.current.discover();
    });

    expect(result.current.hasPageList).toBe(true);
    expect(result.current.pageCount).toBe(3);

    await act(async () => {
      await result.current.beginCrawl();
    });

    const options = crawl.startCrawl.mock.calls[0]?.[0];
    expect(options.orderedUrls).toHaveLength(3);
    expect(options.discoveredTotal).toBe(3);
  });

  it('falls back to the discovered total when discovery lists nothing at all', async () => {
    api.discoverCrawlUrls.mockResolvedValue({ total_found: 47, capped: false });

    const { result } = mount();
    await act(async () => {
      await result.current.discover();
    });

    expect(result.current.hasPageList).toBe(false);
    expect(result.current.pageCount).toBe(47);
  });
});
