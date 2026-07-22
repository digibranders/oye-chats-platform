import * as apiModule from '../../../services/api';
import { diffRecrawl, getRecrawlStatus } from '../../../services/api';

/**
 * recrawl-api — locally-typed access to the crawl-lifecycle endpoints the
 * Knowledge tab needs. The shared `services/api` declarations return loose
 * `Record<string, unknown>` for these (and `updateRecrawl` isn't declared at
 * all), so this module narrows those responses into the strict shapes the
 * Knowledge components consume — without touching the shared services layer.
 */

export type RecrawlMode = 'full' | 'delta';

/** Server payload from `POST /documents/recrawl-diff` (see document_routes.py). */
export interface RecrawlDiffData {
  sitemapTotal: number;
  unchanged: number;
  newPages: number;
  removedPages: number;
  unchangedUrls: string[];
  newUrls: string[];
  removedUrls: string[];
  costPerPage: number;
  creditsRequiredFull: number;
  balance: number;
  exceedsBalance: boolean;
  capped: boolean;
}

/** A resolved diff ready to render — server data plus the source it describes. */
export interface RecrawlDiff extends RecrawlDiffData {
  mode: RecrawlMode;
  docName: string;
  crawlUrl: string;
  replaceSource: string;
}

/** One row of a bot's auto-recrawl history (`bot.recrawl_history`). */
export interface RecrawlHistoryEntry {
  ranAt: string | null;
  status: string | null;
  unchanged: number;
  changed: number;
  failed: number;
}

/** Server payload from `GET /bots/{id}/recrawl` (bot_routes.py). */
export interface RecrawlStatus {
  enabled: boolean;
  featureAvailable: boolean;
  cadenceDays: number;
  nextRecrawlAt: string | null;
  lastRecrawlAt: string | null;
  lastRecrawlStatus: string | null;
  sourcesCount: number;
  history: RecrawlHistoryEntry[];
}

// ── Coercion helpers ────────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

// ── Wrappers ────────────────────────────────────────────────────────────────

/** The registrable root domain of a source name, e.g. `https://www.x.com/a` → `x.com`. */
export function rootDomainOf(name: string): string {
  return name
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split('/')[0]
    .toLowerCase();
}

/** An absolute crawl URL for a source name, adding `https://` when it's bare. */
export function crawlUrlFor(name: string): string {
  return name.startsWith('http') ? name : `https://${name}`;
}

/**
 * Fetch the pre-recrawl diff (unchanged / new / removed buckets + credit math)
 * for a source, narrowed from the loose `diffRecrawl` response.
 */
export async function fetchRecrawlDiff(
  url: string,
  replaceSource: string,
  botId: number,
  mode: RecrawlMode,
): Promise<RecrawlDiffData> {
  const raw = asRecord(await diffRecrawl(url, replaceSource, botId, mode));
  return {
    sitemapTotal: asNumber(raw.sitemap_total),
    unchanged: asNumber(raw.unchanged),
    newPages: asNumber(raw.new_pages),
    removedPages: asNumber(raw.removed_pages),
    unchangedUrls: asStringArray(raw.unchanged_urls),
    newUrls: asStringArray(raw.new_urls),
    removedUrls: asStringArray(raw.removed_urls),
    costPerPage: asNumber(raw.cost_per_page, 1),
    creditsRequiredFull: asNumber(raw.credits_required_full),
    balance: asNumber(raw.balance),
    exceedsBalance: asBoolean(raw.exceeds_balance),
    capped: asBoolean(raw.capped),
  };
}

function parseHistory(value: unknown): RecrawlHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const row = asRecord(item);
    return {
      ranAt: asString(row.ran_at),
      status: asString(row.status),
      unchanged: asNumber(row.unchanged),
      changed: asNumber(row.changed),
      failed: asNumber(row.failed),
    };
  });
}

function parseRecrawlStatus(raw: Record<string, unknown>): RecrawlStatus {
  return {
    enabled: asBoolean(raw.enabled),
    featureAvailable: asBoolean(raw.feature_available),
    cadenceDays: asNumber(raw.cadence_days, 7),
    nextRecrawlAt: asString(raw.next_recrawl_at),
    lastRecrawlAt: asString(raw.last_recrawl_at),
    lastRecrawlStatus: asString(raw.last_recrawl_status),
    sourcesCount: asNumber(raw.sources_count),
    history: parseHistory(raw.recrawl_history),
  };
}

/** Fetch a bot's auto-recrawl status + run history. */
export async function fetchRecrawlStatus(botId: number): Promise<RecrawlStatus> {
  return parseRecrawlStatus(asRecord(await getRecrawlStatus(botId)));
}

// `updateRecrawl` exists in `services/api.js` (PATCH /bots/{id}/recrawl) but is
// not present in the `.d.ts`, so reach it through a narrowed module cast rather
// than editing the shared declarations.
type UpdateRecrawlFn = (botId: number, enabled: boolean) => Promise<Record<string, unknown>>;

const rawUpdateRecrawl = (apiModule as unknown as { updateRecrawl: UpdateRecrawlFn }).updateRecrawl;

/** Toggle a bot's weekly auto-recrawl and return the fresh status. */
export async function setAutoRecrawl(botId: number, enabled: boolean): Promise<RecrawlStatus> {
  return parseRecrawlStatus(asRecord(await rawUpdateRecrawl(botId, enabled)));
}

/** Narrow an unknown thrown value into the structured API-error shape we branch on. */
export interface ApiErrorShape {
  status?: number;
  message?: string;
  detail?: { error?: string; feature?: string; message?: string } | string;
}

export function asApiError(err: unknown): ApiErrorShape {
  return err && typeof err === 'object' ? (err as ApiErrorShape) : {};
}
