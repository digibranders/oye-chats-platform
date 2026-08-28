import { useEffect, useState } from 'react';
import { getCrawlProgress, type CrawlProgress } from '../services/api';
import { isCrawlFinished } from './firstRun';

const POLL_MS = 3000;

export interface CrawlWatch {
  progress: CrawlProgress | null;
  /** True until the first poll answers, so the header does not flash "idle". */
  pending: boolean;
}

/**
 * Follow the crawl the first run started.
 *
 * Polling, because there is no push channel for ingestion — and it stops the
 * moment the crawl reaches a terminal state rather than running for the life of
 * the session. The screen this serves is the one a new customer sits on, so a
 * poll that never stops is a poll that runs all afternoon.
 *
 * `getCrawlProgress` never rejects; a network failure resolves to `idle`. That
 * is the right shape here: a dropped request should not turn a running crawl
 * into an error message.
 */
export function useCrawlWatch(enabled: boolean): CrawlWatch {
  const [progress, setProgress] = useState<CrawlProgress | null>(null);
  const [pending, setPending] = useState(enabled);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let timer: number | undefined;

    async function poll(): Promise<void> {
      const next = await getCrawlProgress();
      if (!active) return;
      setProgress(next);
      setPending(false);
      if (isCrawlFinished(next.status)) return;
      timer = window.setTimeout(() => void poll(), POLL_MS);
    }

    void poll();
    return () => {
      active = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [enabled]);

  return { progress, pending };
}
