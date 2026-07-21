/**
 * Shared domain types for the reused backend layer.
 *
 * These describe the shapes returned by the legacy JS API/contexts, so new
 * TypeScript code gets real types when it consumes them (via the `.d.ts` shims
 * next to those JS modules). Kept intentionally minimal — only the fields the
 * new app reads — and widened as more surfaces are migrated.
 */

export interface Bot {
  id: number;
  name: string;
  bot_key?: string;
  website?: string;
  company_name?: string;
  primary_color?: string;
  bot_logo?: string | null;
  recommended_colors?: string[];
  widget_installed_at?: string | null;
  crawl_completed_at?: string | null;
  last_crawl_status?: string | null;
  indexed_chunk_count?: number;
}

export interface CurrentUser {
  id: number;
  name?: string;
  email?: string;
  company_name?: string;
  website?: string;
  bot_count?: number;
  is_verified?: boolean;
  onboarding_complete?: boolean;
  is_affiliate_only?: boolean;
  is_superadmin?: boolean;
}

export interface Workspace {
  id: number;
  name: string;
  role: string;
  bot_count?: number;
}

export interface DocumentSummary {
  id: number;
  title?: string;
  source_url?: string;
  chunk_count?: number;
}

export type CrawlStatus =
  | 'idle'
  | 'running'
  | 'cancelling'
  | 'cancelled'
  | 'done'
  | 'failed'
  | 'no_content';

export interface CrawlState {
  status: CrawlStatus;
  urls: string[];
  pagesCrawled: number;
  maxPages: number | null;
  discoveredTotal: number | null;
  currentUrl: string | null;
  phase: string | null;
  startedAt: number | null;
  rootUrl: string | null;
  botId: number | null;
  botName: string | null;
  result: unknown;
  error: string | null;
  cancellable: boolean;
  isStarting: boolean;
  cancelInFlight: boolean;
}
