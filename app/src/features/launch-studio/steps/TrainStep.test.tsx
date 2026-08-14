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
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TrainStep } from './TrainStep';
import type { Bot } from '../../../types/domain';

const getCurrentUser = vi.fn();
const getDocuments = vi.fn();

vi.mock('../../../services/api', () => ({
  getCurrentUser: () => getCurrentUser(),
  getDocuments: (...args: unknown[]) => getDocuments(...args),
  getDocumentPages: vi.fn().mockResolvedValue({ pages: [] }),
  discoverCrawlUrls: vi.fn(),
  updateBot: vi.fn(),
  uploadDocuments: vi.fn(),
  recordActivationEvent: vi.fn(),
}));

let selectedBot: Bot | null = null;

vi.mock('../../../context/BotContext', () => ({
  useBotContext: () => ({ selectedBot }),
}));

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
    startCrawl: vi.fn(),
  }),
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
