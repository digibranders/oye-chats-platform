import {
  diffRecrawl,
  getIngestStatus,
  getRecrawlStatus,
  updateRecrawl,
  type IngestJobStatus,
} from '../../../services/api';
import type { RecrawlDiffData, RecrawlMode } from './knowledge-model';

/**
 * Typed access to the crawl-lifecycle endpoints.
 *
 * The shared client answers these as `Record<string, unknown>`, which means
 * every consumer that reads `raw.new_pages` is one rename away from silently
 * rendering `undefined` as a page count. Narrowing happens once, here, and the
 * components downstream only ever see the strict shape.
 */

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

// ── Errors ─────────────────────────────────────────────────────────────────

export interface ApiErrorShape {
  status?: number;
  message?: string;
  detail?: { error?: string; feature?: string; message?: string; max?: number; current?: number } | string | null;
}

export function asApiError(cause: unknown): ApiErrorShape {
  return cause !== null && typeof cause === 'object' ? (cause as ApiErrorShape) : {};
}

export function errorMessage(cause: unknown, fallback: string): string {
  const message = asApiError(cause).message;
  if (typeof message === 'string' && message.length > 0) return message;
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

/** True when the server refused because the plan does not include the feature. */
export function isPlanLocked(cause: unknown, feature?: string): boolean {
  const error = asApiError(cause);
  if (error.status !== 403) return false;
  const detail = typeof error.detail === 'object' && error.detail !== null ? error.detail : null;
  if (detail?.error !== 'feature_not_available' && detail?.error !== 'feature_locked') return false;
  return feature === undefined || detail.feature === feature;
}

/** True when the caller's seat may read this chatbot's knowledge but not change it. */
export function isForbidden(cause: unknown): boolean {
  return asApiError(cause).status === 403;
}

// ── Re-crawl diff ──────────────────────────────────────────────────────────

export async function fetchRecrawlDiff(
  crawlUrl: string,
  replaceSource: string,
  botId: number,
  mode: RecrawlMode,
): Promise<RecrawlDiffData> {
  const raw = asRecord(await diffRecrawl(crawlUrl, replaceSource, botId, mode));
  return {
    sitemapTotal: asNumber(raw.sitemap_total),
    existingTotal: asNumber(raw.existing_total),
    unchanged: asNumber(raw.unchanged),
    newPages: asNumber(raw.new_pages),
    removedPages: asNumber(raw.removed_pages),
    unchangedUrls: asStringArray(raw.unchanged_urls),
    newUrls: asStringArray(raw.new_urls),
    removedUrls: asStringArray(raw.removed_urls),
    costPerPage: Math.max(1, asNumber(raw.cost_per_page, 1)),
    balance: asNumber(raw.balance),
    capped: raw.capped === true,
    headPartial: raw.head_partial === true,
    planMax: asNumber(raw.plan_max, -1),
  };
}

// ── Auto-retrain ───────────────────────────────────────────────────────────

export interface RecrawlRun {
  ranAt: string | null;
  status: string | null;
  unchanged: number;
  changed: number;
  failed: number;
}

export interface RecrawlStatus {
  enabled: boolean;
  /** False when the plan does not include weekly auto-retrain. */
  featureAvailable: boolean;
  cadenceDays: number;
  nextRecrawlAt: string | null;
  lastRecrawlAt: string | null;
  lastRecrawlStatus: string | null;
  /**
   * How many crawled PAGES the weekly job re-reads.
   *
   * Named for what it counts, not for the wire field it comes from. The API
   * calls it `sources_count`, and it is
   * `count(distinct document_name) where source = 'crawl'` — one crawled page
   * is one Document named by its own URL, so a single website of 20 pages
   * answers 20. That name is what made this card say "20 trained websites".
   * The number is right: `_load_crawl_urls_for_bot`, which decides what the
   * weekly job actually fetches, runs the identical query.
   */
  pageCount: number;
  history: RecrawlRun[];
}

function parseRecrawlStatus(raw: Record<string, unknown>): RecrawlStatus {
  const history = Array.isArray(raw.recrawl_history) ? raw.recrawl_history : [];
  return {
    enabled: raw.enabled === true,
    featureAvailable: raw.feature_available === true,
    cadenceDays: asNumber(raw.cadence_days, 7),
    nextRecrawlAt: asString(raw.next_recrawl_at),
    lastRecrawlAt: asString(raw.last_recrawl_at),
    lastRecrawlStatus: asString(raw.last_recrawl_status),
    pageCount: asNumber(raw.sources_count),
    history: history.map((entry) => {
      const row = asRecord(entry);
      return {
        ranAt: asString(row.ran_at),
        status: asString(row.status),
        unchanged: asNumber(row.unchanged),
        changed: asNumber(row.changed),
        failed: asNumber(row.failed),
      };
    }),
  };
}

export async function fetchRecrawlStatus(botId: number): Promise<RecrawlStatus> {
  return parseRecrawlStatus(asRecord(await getRecrawlStatus(botId)));
}

export async function setAutoRecrawl(botId: number, enabled: boolean): Promise<RecrawlStatus> {
  return parseRecrawlStatus(asRecord(await updateRecrawl(botId, enabled)));
}

// ── Upload ingestion ───────────────────────────────────────────────────────

export type { IngestJobStatus };

/**
 * Poll one background ingestion job.
 *
 * Answers `null` — not an error — when the API runs without the ARQ worker
 * (HTTP 501). Ingestion still happens, inline, and there is simply no job to
 * watch; a customer should be told that their document is being read, not shown
 * a failure for a deployment detail they cannot see.
 */
export async function fetchIngestStatus(jobId: string): Promise<IngestJobStatus | null> {
  try {
    return await getIngestStatus(jobId);
  } catch (cause) {
    if (asApiError(cause).status === 501) return null;
    throw cause;
  }
}
