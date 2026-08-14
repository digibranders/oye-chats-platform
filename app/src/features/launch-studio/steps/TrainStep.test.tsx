/**
 * The Train step must not ask for a URL the product already knows.
 *
 * Signup stores the account's website, and step 2 creates an agent that has
 * none of its own - so the field prefills from the agent first, the account
 * second. Both sources resolve asynchronously, which rules out a one-shot
 * `useState` initialiser: the value has to land when the data does, without
 * ever overwriting what the user typed in the meantime.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TrainStep } from './TrainStep';
import type { Bot, CrawlDiscovery } from '../../../types/domain';

const getCurrentUser = vi.fn();
const getDocuments = vi.fn();
const discoverCrawlUrls = vi.fn();
const updateBot = vi.fn();

vi.mock('../../../services/api', () => ({
  getCurrentUser: () => getCurrentUser(),
  getDocuments: (...args: unknown[]) => getDocuments(...args),
  getDocumentPages: vi.fn().mockResolvedValue({ pages: [] }),
  discoverCrawlUrls: (...args: unknown[]) => discoverCrawlUrls(...args),
  updateBot: (...args: unknown[]) => updateBot(...args),
  uploadDocuments: vi.fn(),
  recordActivationEvent: vi.fn(),
}));

let selectedBot: Bot | null = null;

vi.mock('../../../context/BotContext', () => ({
  useBotContext: () => ({ selectedBot }),
}));

const startCrawl = vi.fn();

vi.mock('../../../context/CrawlContext', () => ({
  useCrawl: () => ({
    crawl: {
      status: 'idle',
      urls: [],
      pagesCrawled: 0,
      maxPages: null,
      discoveredTotal: null,
      currentUrl: null,
      rootUrl: null,
      botId: null,
      botName: null,
      error: null,
    },
    startCrawl: (...args: unknown[]) => startCrawl(...args),
  }),
}));

/** `-1` = unlimited. Tests set this to exercise the `page_scraping` cap. */
let pageScrapingLimit = -1;

vi.mock('../../../hooks/useEntitlements', () => ({
  useEntitlements: () => ({
    limitFor: () => pageScrapingLimit,
    withinLimit: (_key: string, current: number) =>
      pageScrapingLimit === -1 || current < pageScrapingLimit,
    remaining: (_key: string, current: number) =>
      pageScrapingLimit === -1 ? Infinity : Math.max(0, pageScrapingLimit - current),
  }),
}));

const openUpgradeModal = vi.fn();

vi.mock('../../../context/UpgradeModalContext', () => ({
  useUpgradeModal: () => ({ openUpgradeModal }),
}));

const stepProps = {
  onContinue: vi.fn(),
  onBack: vi.fn(),
  isFirst: false,
  isLast: false,
};

interface Profile {
  id: number;
  website: string;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/**
 * Resolve the pending `/auth/me` read and flush every state update it triggers.
 *
 * The no-clobber assertions are assertions of ABSENCE, so they must not race
 * the effect they are guarding against - `waitFor` would happily pass before
 * the prefill had a chance to land.
 */
async function settleProfile(profile: {
  promise: Promise<Profile>;
  resolve: (value: Profile) => void;
}): Promise<void> {
  profile.resolve({ id: 1, website: 'https://www.fynix.digital' });
  await act(async () => {
    await profile.promise;
  });
}

function agent(website?: string | null): Bot {
  return { id: 7, name: 'Ava', ...(website === undefined ? {} : { website: website ?? undefined }) };
}

function urlField(): HTMLInputElement {
  return screen.getByRole('textbox') as HTMLInputElement;
}

describe('TrainStep website prefill', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectedBot = agent();
    pageScrapingLimit = -1;
    getDocuments.mockResolvedValue([]);
    getCurrentUser.mockResolvedValue({ id: 1, website: 'https://www.fynix.digital' });
  });

  it("uses the agent's own website when it has one", async () => {
    selectedBot = agent('https://docs.agent-site.com');
    render(<TrainStep {...stepProps} />);

    expect(urlField().value).toBe('https://docs.agent-site.com');
    // The account website must not replace it once /auth/me lands.
    await waitFor(() => expect(getCurrentUser).toHaveBeenCalled());
    await waitFor(() => expect(urlField().value).toBe('https://docs.agent-site.com'));
  });

  it('falls back to the account website for an agent created moments ago', async () => {
    render(<TrainStep {...stepProps} />);

    await waitFor(() => expect(urlField().value).toBe('https://www.fynix.digital'));
  });

  it('leaves the field empty when neither the agent nor the account has a website', async () => {
    getCurrentUser.mockResolvedValue({ id: 1, website: null });
    render(<TrainStep {...stepProps} />);

    await waitFor(() => expect(getCurrentUser).toHaveBeenCalled());
    await waitFor(() => expect(urlField().value).toBe(''));
  });

  it('leaves the field empty when the profile read fails', async () => {
    getCurrentUser.mockRejectedValue(new Error('network'));
    render(<TrainStep {...stepProps} />);

    await waitFor(() => expect(getCurrentUser).toHaveBeenCalled());
    await waitFor(() => expect(urlField().value).toBe(''));
  });

  it('prefills from late-arriving account data', async () => {
    const profile = deferred<Profile>();
    getCurrentUser.mockReturnValue(profile.promise);

    render(<TrainStep {...stepProps} />);
    expect(urlField().value).toBe('');

    profile.resolve({ id: 1, website: 'https://www.fynix.digital' });
    await waitFor(() => expect(urlField().value).toBe('https://www.fynix.digital'));
  });

  it('prefills from a late-arriving agent, which then wins over the account website', async () => {
    const { rerender } = render(<TrainStep {...stepProps} />);
    await waitFor(() => expect(urlField().value).toBe('https://www.fynix.digital'));

    selectedBot = agent('https://docs.agent-site.com');
    rerender(<TrainStep {...stepProps} />);

    await waitFor(() => expect(urlField().value).toBe('https://docs.agent-site.com'));
  });

  it('never overwrites what the user typed before the data arrived', async () => {
    const profile = deferred<Profile>();
    getCurrentUser.mockReturnValue(profile.promise);

    const { rerender } = render(<TrainStep {...stepProps} />);
    fireEvent.change(urlField(), { target: { value: 'my-other-site.com' } });

    await settleProfile(profile);
    expect(urlField().value).toBe('my-other-site.com');

    // A late agent must not clobber it either.
    selectedBot = agent('https://docs.agent-site.com');
    rerender(<TrainStep {...stepProps} />);
    expect(urlField().value).toBe('my-other-site.com');
  });

  it('keeps the field empty when the user deliberately cleared it', async () => {
    const profile = deferred<Profile>();
    getCurrentUser.mockReturnValue(profile.promise);

    render(<TrainStep {...stepProps} />);
    fireEvent.change(urlField(), { target: { value: 'typed' } });
    fireEvent.change(urlField(), { target: { value: '' } });

    await settleProfile(profile);
    expect(urlField().value).toBe('');
  });
});

/**
 * Scanning is the step's explicit, free action; the tree it fills is the review;
 * and the footer CTA is the click that spends credits. These tests pin the three
 * things that make that safe: the page list actually renders, the cost tracks
 * the SELECTION rather than the discovery, and neither the plan's page
 * allowance nor an empty credit balance can be walked past.
 */
describe('TrainStep website scan', () => {
  const PAGES = [
    'https://site.com/',
    'https://site.com/about',
    'https://site.com/pricing',
    'https://site.com/blog',
  ];

  function discovery(over: Partial<CrawlDiscovery> = {}): CrawlDiscovery {
    return {
      url: 'https://site.com',
      total_found: PAGES.length,
      capped: false,
      plan_max: -1,
      urls: PAGES,
      cost_per_page: 5,
      balance: 10_000,
      max_affordable_pages: 2_000,
      credits_required_full: PAGES.length * 5,
      exceeds_balance: false,
      ...over,
    };
  }

  function renderStep() {
    return render(
      <MemoryRouter>
        <TrainStep {...stepProps} />
      </MemoryRouter>,
    );
  }

  function scanButton(): HTMLElement {
    return screen.getByRole('button', { name: /scan website/i });
  }
  function trainButton(): HTMLElement {
    return screen.getByRole('button', { name: /train your chatbot/i });
  }

  /** Type a stable address and run the scan. */
  async function scanSite(): Promise<void> {
    fireEvent.change(urlField(), { target: { value: 'site.com' } });
    fireEvent.click(scanButton());
    await waitFor(() => expect(screen.getAllByRole('tree').length).toBeGreaterThan(0));
  }

  /**
   * Toggle one page in the tree. The tree renders twice (inline + the
   * auto-opened maximized modal) over shared state, so either copy will do.
   */
  function togglePage(label: string): void {
    fireEvent.click(screen.getAllByRole('button', { name: label })[0]);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    selectedBot = agent();
    pageScrapingLimit = -1;
    getDocuments.mockResolvedValue([]);
    getCurrentUser.mockResolvedValue({ id: 1, website: null });
    discoverCrawlUrls.mockResolvedValue(discovery());
    updateBot.mockResolvedValue({});
    startCrawl.mockResolvedValue({});
  });

  it('does not discover until the user asks - Continue no longer scans', async () => {
    renderStep();
    fireEvent.change(urlField(), { target: { value: 'site.com' } });

    // A URL alone must not arm the primary action: scanning is the next step,
    // and it has its own button.
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
    expect(discoverCrawlUrls).not.toHaveBeenCalled();
  });

  it('scan populates the hierarchical page tree', async () => {
    renderStep();
    await scanSite();

    expect(discoverCrawlUrls).toHaveBeenCalledWith('https://site.com', 7);
    expect(screen.getAllByText(/Choose which to train on below/).length).toBeGreaterThan(0);
    // Every discovered page is offered as a selectable node.
    for (const label of ['about', 'pricing', 'blog']) {
      expect(screen.getAllByRole('button', { name: label }).length).toBeGreaterThan(0);
    }
  });

  it('selection drives the page count and the credit estimate', async () => {
    renderStep();
    await scanSite();

    // Seeded with everything: 4 pages x 5 credits.
    expect(screen.getByText('4 of 4 pages selected')).toBeTruthy();
    expect(screen.getByText(/About 20 credits · 5 per page/)).toBeTruthy();

    togglePage('about');

    // Mutation check: both the count AND the price must move with the
    // selection - a hard-coded total would keep saying "4" / "20 credits".
    expect(screen.getByText('3 of 4 pages selected')).toBeTruthy();
    expect(screen.getByText(/About 15 credits · 5 per page/)).toBeTruthy();
    expect(screen.queryByText('4 of 4 pages selected')).toBeNull();
    expect(screen.queryByText(/About 20 credits/)).toBeNull();
  });

  it('trains on exactly the selected pages, and sizes progress to them', async () => {
    renderStep();
    await scanSite();
    togglePage('about');

    fireEvent.click(trainButton());
    await waitFor(() => expect(startCrawl).toHaveBeenCalled());

    const opts = startCrawl.mock.calls[0][0];
    // Exactly the ticked pages - the deselected one is not fetched or billed.
    // Asserted as a set: the ORDER of a toggled selection is decided by the
    // shared `CrawlPageTree` (it re-emits in tree order), not by this step.
    expect([...opts.orderedUrls].sort()).toEqual([
      'https://site.com/',
      'https://site.com/blog',
      'https://site.com/pricing',
    ]);
    expect(opts.orderedUrls).not.toContain('https://site.com/about');
    // The progress screen's denominator. Sending the discovery-wide count here
    // would make it read "0 of 4" for a 3-page crawl that can never complete.
    expect(opts.discoveredTotal).toBe(3);
    expect(opts.maxPages).toBe(3);
  });

  it('blocks the CTA when nothing is selected', async () => {
    renderStep();
    await scanSite();

    fireEvent.click(screen.getAllByRole('button', { name: /clear all/i })[0]);

    expect(screen.getByText('0 of 4 pages selected')).toBeTruthy();
    expect(trainButton()).toBeDisabled();
  });

  it('caps the seeded selection to what the plan still allows', async () => {
    pageScrapingLimit = 2;
    renderStep();
    await scanSite();

    // 4 pages found, plan covers 2 - only 2 are pre-ticked, and the CTA is live.
    expect(screen.getByText('2 of 4 pages selected')).toBeTruthy();
    expect(screen.getByText(/About 10 credits/)).toBeTruthy();
    expect(trainButton()).not.toBeDisabled();
  });

  it('refuses to start a crawl that exceeds the plan page allowance', async () => {
    pageScrapingLimit = 2;
    renderStep();
    await scanSite();

    // Ticking everything pushes past the allowance: blocked here, with an
    // upgrade path - not discovered as a 400 after the user commits.
    fireEvent.click(screen.getAllByRole('button', { name: /select all/i })[0]);

    expect(screen.getByText('4 of 4 pages selected')).toBeTruthy();
    expect(screen.getByText(/Your plan covers 2 more pages/)).toBeTruthy();
    expect(trainButton()).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /upgrade plan/i }));
    expect(openUpgradeModal).toHaveBeenCalled();
  });

  it('honours the per-crawl ceiling the server reports for the plan', async () => {
    // Unlimited `page_scraping` client-side, but the server caps this plan's
    // crawl at 1 page - the tighter of the two must win.
    discoverCrawlUrls.mockResolvedValue(discovery({ plan_max: 1 }));
    renderStep();
    await scanSite();

    expect(screen.getByText('1 of 4 pages selected')).toBeTruthy();
  });

  it('keeps the no-balance guard firing before any crawl starts', async () => {
    discoverCrawlUrls.mockResolvedValue(
      discovery({ exceeds_balance: true, max_affordable_pages: 0, balance: 0 }),
    );
    renderStep();
    await scanSite();

    expect(screen.getByText(/You need credits to train on this site/)).toBeTruthy();
    // Nothing affordable, so nothing is pre-ticked.
    expect(screen.getByText('0 of 4 pages selected')).toBeTruthy();
    expect(trainButton()).toBeDisabled();

    // The guard must survive the user ticking pages anyway - an empty balance
    // blocks the crawl on its own, not merely as a side-effect of an empty
    // selection.
    fireEvent.click(screen.getAllByRole('button', { name: /select all/i })[0]);
    expect(screen.getByText('4 of 4 pages selected')).toBeTruthy();
    expect(trainButton()).toBeDisabled();

    fireEvent.click(trainButton());
    expect(startCrawl).not.toHaveBeenCalled();
  });

  it('warns, but still trains, when the selection outruns the credit balance', async () => {
    discoverCrawlUrls.mockResolvedValue(
      discovery({ exceeds_balance: true, max_affordable_pages: 2, balance: 10 }),
    );
    renderStep();
    await scanSite();

    // Seeded down to what the credits buy...
    expect(screen.getByText('2 of 4 pages selected')).toBeTruthy();
    // ...and over-selecting warns rather than blocks: the backend trains as
    // many as the balance covers, in order.
    fireEvent.click(screen.getAllByRole('button', { name: /select all/i })[0]);
    expect(screen.getByText(/more pages than your credits cover/)).toBeTruthy();
    expect(trainButton()).not.toBeDisabled();
  });

  it('falls back to link-following when the site has no sitemap', async () => {
    discoverCrawlUrls.mockResolvedValue(discovery({ total_found: 0, urls: [] }));
    renderStep();
    fireEvent.change(urlField(), { target: { value: 'site.com' } });
    fireEvent.click(scanButton());

    await waitFor(() =>
      expect(screen.getByText(/we'll follow links from your homepage/i)).toBeTruthy(),
    );
    // No page list means nothing to tick - but the crawl is still offered.
    expect(screen.queryByRole('tree')).toBeNull();
    expect(trainButton()).not.toBeDisabled();
  });

  it('editing the address discards the pages found for the old one', async () => {
    renderStep();
    await scanSite();

    fireEvent.change(urlField(), { target: { value: 'other-site.com' } });

    expect(screen.queryByRole('tree')).toBeNull();
    expect(screen.queryByText(/pages selected/)).toBeNull();
    expect(scanButton()).not.toBeDisabled();
  });

  it('returns to a clean, prefilled scan form after leaving mid-scan', async () => {
    selectedBot = agent('https://site.com');
    getCurrentUser.mockResolvedValue({ id: 1, website: 'https://account-site.com' });

    const { unmount } = renderStep();
    await scanSite();
    expect(screen.getByText('4 of 4 pages selected')).toBeTruthy();

    // Leaving the step and coming back must not resurrect a half-finished scan
    // or strand the user on a screen with no way forward.
    unmount();
    renderStep();

    await waitFor(() => expect(urlField().value).toBe('https://site.com'));
    expect(screen.queryByRole('tree')).toBeNull();
    expect(scanButton()).not.toBeDisabled();
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled();
  });
});
