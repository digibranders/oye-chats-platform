/**
 * The Knowledge tab must not ask for a URL the product already stored - and
 * must not hand back a URL it has already been paid to crawl.
 *
 * The create-chatbot modal saves `Bot.website`, so a chatbot arriving on
 * `/agents/:id/knowledge` for the first time already has a site on file; the
 * account website captured at signup is the fallback. Both resolve
 * asynchronously, which rules out a one-shot `useState` initialiser.
 *
 * The second half of the file pins the money-shaped half of the rule: once a
 * site is in the knowledge base, the field stays empty. Website crawls bill per
 * page, so re-offering a trained URL one click away from "Check pages" →
 * "Train on N pages" is a re-crawl the user never asked for.
 */

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AddKnowledgePanel } from './AddKnowledgePanel';
import type { CrawlState, KnowledgeSource } from '../../../types/domain';

const getCurrentUser = vi.fn();
const discoverCrawlUrls = vi.fn();

vi.mock('../../../services/api', () => ({
  getCurrentUser: () => getCurrentUser(),
  discoverCrawlUrls: (...args: unknown[]) => discoverCrawlUrls(...args),
  previewUploadCost: vi.fn(),
  uploadDocuments: vi.fn(),
}));

const startCrawl = vi.fn();
const cancelCrawl = vi.fn();

function idleCrawl(): CrawlState {
  return {
    status: 'idle',
    urls: [],
    pagesCrawled: 0,
    maxPages: null,
    discoveredTotal: null,
    currentUrl: null,
    phase: null,
    startedAt: null,
    rootUrl: null,
    botId: null,
    botName: null,
    result: null,
    error: null,
    cancellable: false,
    isStarting: false,
    cancelInFlight: false,
  };
}

let crawlState: CrawlState = idleCrawl();

vi.mock('../../../context/CrawlContext', () => ({
  useCrawl: () => ({ crawl: crawlState, startCrawl, cancelCrawl }),
}));

vi.mock('../../../context/UpgradeModalContext', () => ({
  useUpgradeModal: () => ({ openUpgradeModal: vi.fn() }),
}));

const AGENT_ID = 11;

function source(name: string): KnowledgeSource {
  return { name, page_count: 4 };
}

function panel(over: { agentWebsite?: string | null; existingSources?: KnowledgeSource[] } = {}) {
  return (
    <AddKnowledgePanel
      agentId={AGENT_ID}
      agentName="Ava"
      agentWebsite={over.agentWebsite ?? null}
      existingSources={over.existingSources ?? []}
      onChanged={vi.fn()}
    />
  );
}

function urlField(): HTMLInputElement {
  return screen.getByLabelText('Website address') as HTMLInputElement;
}

interface Profile {
  id: number;
  website: string | null;
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
 * the effect they guard against - `waitFor` would happily pass before the
 * prefill had a chance to land.
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

beforeEach(() => {
  vi.clearAllMocks();
  crawlState = idleCrawl();
  getCurrentUser.mockResolvedValue({ id: 1, website: 'https://www.fynix.digital' });
});

describe('AddKnowledgePanel website prefill', () => {
  it("uses the chatbot's own stored website", async () => {
    render(panel({ agentWebsite: 'https://oyechats.com' }));

    expect(urlField().value).toBe('https://oyechats.com');
    // The account website must not replace it once /auth/me lands.
    await waitFor(() => expect(getCurrentUser).toHaveBeenCalled());
    await waitFor(() => expect(urlField().value).toBe('https://oyechats.com'));
  });

  it('falls back to the account website when the chatbot has none', async () => {
    render(panel());

    await waitFor(() => expect(urlField().value).toBe('https://www.fynix.digital'));
  });

  it('leaves the field empty when neither the chatbot nor the account has one', async () => {
    getCurrentUser.mockResolvedValue({ id: 1, website: null });
    render(panel());

    await waitFor(() => expect(getCurrentUser).toHaveBeenCalled());
    // Never the literal text "null"/"undefined".
    await waitFor(() => expect(urlField().value).toBe(''));
    expect(urlField().value).not.toMatch(/null|undefined/);
  });

  it('leaves the field empty when the profile read fails', async () => {
    getCurrentUser.mockRejectedValue(new Error('network'));
    render(panel());

    await waitFor(() => expect(getCurrentUser).toHaveBeenCalled());
    await waitFor(() => expect(urlField().value).toBe(''));
  });

  it('prefills from late-arriving account data', async () => {
    const profile = deferred<Profile>();
    getCurrentUser.mockReturnValue(profile.promise);

    render(panel());
    expect(urlField().value).toBe('');

    profile.resolve({ id: 1, website: 'https://www.fynix.digital' });
    await waitFor(() => expect(urlField().value).toBe('https://www.fynix.digital'));
  });

  it('prefills from a late-arriving chatbot website, which then wins over the account', async () => {
    const { rerender } = render(panel());
    await waitFor(() => expect(urlField().value).toBe('https://www.fynix.digital'));

    rerender(panel({ agentWebsite: 'https://oyechats.com' }));

    await waitFor(() => expect(urlField().value).toBe('https://oyechats.com'));
  });

  it('never overwrites what the user typed before the data arrived', async () => {
    const profile = deferred<Profile>();
    getCurrentUser.mockReturnValue(profile.promise);

    const { rerender } = render(panel());
    fireEvent.change(urlField(), { target: { value: 'docs.my-other-site.com' } });

    await settleProfile(profile);
    expect(urlField().value).toBe('docs.my-other-site.com');

    // A late chatbot website must not clobber it either.
    rerender(panel({ agentWebsite: 'https://oyechats.com' }));
    expect(urlField().value).toBe('docs.my-other-site.com');
  });

  it('keeps the field empty when the user deliberately cleared it', async () => {
    const profile = deferred<Profile>();
    getCurrentUser.mockReturnValue(profile.promise);

    render(panel());
    fireEvent.change(urlField(), { target: { value: 'typed' } });
    fireEvent.change(urlField(), { target: { value: '' } });

    await settleProfile(profile);
    expect(urlField().value).toBe('');
  });

  it('sends a prefilled bare domain through the same normalisation as a typed one', async () => {
    // `POST /crawl/discover` rejects a URL with no scheme, so a prefill must not
    // bypass `normalizeUrl` just because the user never touched the field.
    discoverCrawlUrls.mockResolvedValue({ total_found: 0, capped: false });
    render(panel({ agentWebsite: 'oyechats.com' }));

    await waitFor(() => expect(urlField().value).toBe('oyechats.com'));
    fireEvent.click(screen.getByRole('button', { name: /check pages/i }));

    await waitFor(() =>
      expect(discoverCrawlUrls).toHaveBeenCalledWith('https://oyechats.com', AGENT_ID),
    );
  });
});

/**
 * The prefill is suppressed for a site that is already trained.
 *
 * This is the money rule. Crawls bill per page, and the panel's re-train path
 * (`RecrawlMenu`) previews a diff and a cost before charging - re-offering a
 * trained URL in the raw crawl field routes the user straight past it.
 */
describe('AddKnowledgePanel prefill suppression for trained sites', () => {
  it('offers nothing when the chatbot has already learned its own site', async () => {
    render(
      panel({
        agentWebsite: 'https://oyechats.com',
        existingSources: [source('https://oyechats.com')],
      }),
    );

    await waitFor(() => expect(getCurrentUser).toHaveBeenCalled());
    expect(urlField().value).toBe('');
  });

  it('matches on host, so www / scheme / path differences still count as trained', async () => {
    render(
      panel({
        agentWebsite: 'oyechats.com',
        existingSources: [source('https://www.oyechats.com/docs')],
      }),
    );

    await waitFor(() => expect(getCurrentUser).toHaveBeenCalled());
    expect(urlField().value).toBe('');
  });

  it('still prefills when the trained sources are all OTHER sites', async () => {
    // Mutation check: the suppression must key on the host, not simply on
    // "this chatbot has some knowledge".
    render(
      panel({
        agentWebsite: 'https://oyechats.com',
        existingSources: [source('https://unrelated.example'), source('handbook.pdf')],
      }),
    );

    await waitFor(() => expect(urlField().value).toBe('https://oyechats.com'));
  });

  it('does not treat an uploaded document as a trained website', async () => {
    // A file named like a host must never suppress a real website prefill.
    render(
      panel({
        agentWebsite: 'https://oyechats.com',
        existingSources: [source('oyechats.com')],
      }),
    );

    await waitFor(() => expect(urlField().value).toBe('https://oyechats.com'));
  });

  it('suppresses the account-website fallback once that site is trained too', async () => {
    // An assertion of ABSENCE: the profile read has to be flushed deliberately,
    // or this passes simply by beating the state update it is guarding against.
    const profile = deferred<Profile>();
    getCurrentUser.mockReturnValue(profile.promise);

    render(panel({ existingSources: [source('https://www.fynix.digital')] }));
    await settleProfile(profile);

    expect(urlField().value).toBe('');
  });
});

/**
 * The panel deliberately clears the website inputs when our crawl finishes, so
 * the field is ready for the next site. The prefill must not undo that - a user
 * who sees the URL they just trained sitting in the box can reasonably conclude
 * it is queued again and press train a second time, at 5 credits a page.
 */
describe('AddKnowledgePanel post-crawl clear', () => {
  function doneCrawl(): CrawlState {
    return { ...idleCrawl(), status: 'done', botId: AGENT_ID, pagesCrawled: 4 };
  }

  it('does not re-fill the field when our crawl of the prefilled site completes', async () => {
    const { rerender } = render(panel({ agentWebsite: 'https://oyechats.com' }));
    await waitFor(() => expect(urlField().value).toBe('https://oyechats.com'));

    // Crawl finishes and the parent refreshes its source list.
    crawlState = doneCrawl();
    rerender(
      panel({
        agentWebsite: 'https://oyechats.com',
        existingSources: [source('https://oyechats.com')],
      }),
    );

    await waitFor(() => expect(screen.getByText(/your AI learned 4 pages/i)).toBeTruthy());
    expect(urlField().value).toBe('');
  });

  it('stays cleared in the tick before the parent has refreshed its sources', async () => {
    const { rerender } = render(panel({ agentWebsite: 'https://oyechats.com' }));
    await waitFor(() => expect(urlField().value).toBe('https://oyechats.com'));

    // Same completion, but the source list has not landed yet.
    crawlState = doneCrawl();
    rerender(panel({ agentWebsite: 'https://oyechats.com' }));

    await waitFor(() => expect(screen.getByText(/your AI learned 4 pages/i)).toBeTruthy());
    expect(urlField().value).toBe('');
  });

  it('re-offers nothing after a remount, where a stale done-crawl still sits in context', async () => {
    // The real double-crawl risk: navigating away and back. `CrawlContext` is
    // global, so `done` survives - but the empty field must come from the
    // source list, not from that transient status.
    crawlState = doneCrawl();
    render(
      panel({
        agentWebsite: 'https://oyechats.com',
        existingSources: [source('https://oyechats.com')],
      }),
    );

    await waitFor(() => expect(getCurrentUser).toHaveBeenCalled());
    expect(urlField().value).toBe('');
  });

  it('keeps prefilling a NOT-yet-trained site even when a done crawl is in context', async () => {
    // Mutation check for the effect ordering: a finished crawl of some other
    // site must not permanently suppress a legitimate prefill on remount.
    crawlState = doneCrawl();
    render(
      panel({
        agentWebsite: 'https://oyechats.com',
        existingSources: [source('https://docs.other-site.com')],
      }),
    );

    await waitFor(() => expect(urlField().value).toBe('https://oyechats.com'));
  });
});
