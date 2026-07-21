import type { ReactElement, ReactNode } from 'react';
import type { CrawlState } from '../types/domain';

/** Type shim for the legacy JS `context/CrawlContext.jsx`. */

export interface StartCrawlOptions {
  url: string;
  botId: number;
  botName?: string | null;
  useJs?: boolean;
  replaceSource?: string | null;
  discoveredTotal?: number | null;
  expectedNewPages?: number | null;
  orderedUrls?: string[] | null;
  maxPages?: number | null;
  mode?: 'delta' | 'full';
}

export interface CrawlContextValue {
  crawl: CrawlState;
  startCrawl: (opts: StartCrawlOptions) => Promise<unknown>;
  cancelCrawl: () => Promise<{ status: string; message: string }>;
  dismissCrawl: () => void;
  isActive: boolean;
  isTerminal: boolean;
}

export const CrawlProvider: (props: { children: ReactNode }) => ReactElement;
export function useCrawl(): CrawlContextValue;
