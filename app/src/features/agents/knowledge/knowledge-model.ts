import { formatNumber } from '../../../ui';
import type { CrawlDiscovery, KnowledgeSource } from '../../../types/domain';
import { t as translateNow } from '../../../i18n/i18n';

/**
 * Everything on this surface that is a decision rather than a rendering.
 *
 * It lives apart from the components because every rule here is either about
 * money or about truthfulness — which pages a re-crawl will actually fetch and
 * bill for, whether a quota is a fault or a price, what a plan allows before a
 * customer spends anything — and rules like that need tests, not a JSX diff.
 */

// ── Sources ────────────────────────────────────────────────────────────────

/** True when a source is a crawled website rather than an uploaded file. */
export function isWebsiteSource(name: string): boolean {
  return /^https?:\/\//i.test(name);
}

/** Prepend `https://` when the customer typed a bare domain. */
export function normalizeSiteUrl(value: string): string {
  const trimmed = value.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/**
 * The registrable host of a source name — `https://www.acme.com/docs` → `acme.com`.
 *
 * This is the exact string the backend's `replace_source` expects (it lowercases
 * and strips `www.` on its own side before comparing), so the same function
 * answers both "have we already trained this site?" and "what do we send as the
 * source to replace?". Two functions that had to agree is one that cannot drift.
 */
export function rootDomainOf(name: string): string {
  return name
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split('/')[0]
    .toLowerCase();
}

/** An absolute crawl URL for a stored source name. */
export function crawlUrlFor(name: string): string {
  return /^https?:\/\//i.test(name) ? name : `https://${name}`;
}

/**
 * How much a source contributes, in the unit the customer would recognise.
 *
 * Grouped, because the label lands in a `figure` cell beside correctly-grouped
 * figures: a 1,204-page website used to read "1204 pages" in the Size column.
 */
export function sourceUnits(source: KnowledgeSource): { count: number; label: string } {
  if (isWebsiteSource(source.name)) {
    const count = source.page_count ?? 0;
    return { count, label: `${formatNumber(count)} page${count === 1 ? '' : 's'}` };
  }
  const count = source.doc_page_count ?? source.chunk_count ?? 0;
  const unit = source.doc_page_count != null ? 'page' : 'passage';
  return { count, label: `${formatNumber(count)} ${unit}${count === 1 ? '' : 's'}` };
}

/** The type filter above the source table. */
export type SourceKind = 'all' | 'websites' | 'documents';

/**
 * The visible set, given the search and the type filter.
 *
 * The table caps at 25 rows a page and had neither control, so a workspace with
 * sixty sources paged through three screens with no way to find `pricing.pdf`.
 */
export function filterSources(
  sources: readonly KnowledgeSource[],
  query: string,
  kind: SourceKind,
): KnowledgeSource[] {
  const needle = query.trim().toLowerCase();
  return sources.filter((source) => {
    if (kind === 'websites' && !isWebsiteSource(source.name)) return false;
    if (kind === 'documents' && isWebsiteSource(source.name)) return false;
    return !needle || source.name.toLowerCase().includes(needle);
  });
}

/** What a source is doing, in the four words a customer needs. */
export type SourceStateKind = 'training' | 'trained' | 'failed';

export interface SourceState {
  kind: SourceStateKind;
  label: string;
  tone: 'neutral' | 'success' | 'danger';
}

/**
 * Whether a source is actually answerable.
 *
 * The table had no ingestion state at all: its only badge said *Website* or
 * *Document*, which is a type, so a source that failed to extract, one still
 * embedding, and one fully trained were visually identical apart from an em dash
 * in the Passages column. "Did that upload work?" is the central question on
 * this page and it was unanswerable.
 *
 * `KnowledgeSource` carries no status field, so this is derived — and it can be,
 * exactly. Passages are the only thing that makes a source answerable, so
 * holding none while having been ingested *is* the failure: extraction found no
 * readable text, which is what a scanned PDF or a JavaScript-only site does.
 * The in-flight crawl is passed in rather than read here, because a model
 * function that reaches for a React context is not testable.
 */
export function sourceState(
  source: KnowledgeSource,
  crawlingDomain: string | null,
): SourceState {
  if (
    crawlingDomain !== null &&
    isWebsiteSource(source.name) &&
    rootDomainOf(source.name) === crawlingDomain
  ) {
    return { kind: 'training', label: translateNow('agents.training') || 'Training', tone: 'neutral' };
  }
  if ((source.chunk_count ?? 0) > 0) {
    return { kind: 'trained', label: translateNow('agents.trained') || 'Trained', tone: 'success' };
  }
  return { kind: 'failed', label: translateNow('agents.notIndexed') || 'Not indexed', tone: 'danger' };
}

export interface KnowledgeSummary {
  total: number;
  websites: number;
  documents: number;
  /** Crawled pages across every website source on this chatbot. */
  websitePages: number;
  /** ISO timestamp of the most recent ingest, or null when nothing is dated. */
  lastIngestedAt: string | null;
}

export function summarise(sources: readonly KnowledgeSource[]): KnowledgeSummary {
  let websites = 0;
  let websitePages = 0;
  let latest: number | null = null;
  for (const source of sources) {
    if (isWebsiteSource(source.name)) {
      websites += 1;
      websitePages += source.page_count ?? 0;
    }
    if (source.ingested_at) {
      const at = Date.parse(source.ingested_at);
      if (Number.isFinite(at) && (latest === null || at > latest)) latest = at;
    }
  }
  return {
    total: sources.length,
    websites,
    documents: sources.length - websites,
    websitePages,
    lastIngestedAt: latest === null ? null : new Date(latest).toISOString(),
  };
}

// ── Plan allowances ────────────────────────────────────────────────────────

/** `-1` is the plan resolver's UNLIMITED sentinel — never a real ceiling. */
export const UNLIMITED = -1;

export interface Allowance {
  used: number;
  /** `-1` for unlimited. */
  limit: number;
  unlimited: boolean;
  /** `Infinity` when unlimited. */
  remaining: number;
  /** 0–1, clamped. `0` when unlimited, so no bar ever fills on an unlimited plan. */
  fraction: number;
  atLimit: boolean;
  /** True from 80% onward — the point at which it is worth saying so. */
  nearLimit: boolean;
}

/**
 * What is left of a plan allowance.
 *
 * Deliberately does not carry a *tone*. A quota that is full is not a fault —
 * it is the price of the plan the customer chose — and the surfaces that render
 * these read `plan`, not `danger`. Encoding the tone here is how "you have used
 * everything you paid for" ends up looking like "something has gone wrong".
 */
export function allowanceOf(used: number, limit: number): Allowance {
  const unlimited = limit === UNLIMITED || limit < 0;
  const safeUsed = Math.max(0, used);
  if (unlimited) {
    return {
      used: safeUsed,
      limit: UNLIMITED,
      unlimited: true,
      remaining: Infinity,
      fraction: 0,
      atLimit: false,
      nearLimit: false,
    };
  }
  const fraction = limit <= 0 ? 1 : Math.min(1, safeUsed / limit);
  return {
    used: safeUsed,
    limit,
    unlimited: false,
    remaining: Math.max(0, limit - safeUsed),
    fraction,
    atLimit: safeUsed >= limit,
    nearLimit: fraction >= 0.8,
  };
}

/** Characters → words, at the ratio the backend's own plan matrix documents. */
export function charactersAsWords(characters: number): number {
  return Math.round(characters / 5);
}

// ── Knowledge gaps ─────────────────────────────────────────────────────────

/**
 * The window on the gaps list.
 *
 * `GET /analytics/unanswered-questions` has always accepted `?days=`, and the
 * console never passed it — so a question asked once, nine months ago, before
 * the document that answers it was uploaded, sat in the list for ever and read
 * as an open gap. `null` is "all time", which stays available and is no longer
 * the only thing on offer.
 */
export const GAP_WINDOWS = [7, 30, 90, null] as const;
export type GapWindow = (typeof GAP_WINDOWS)[number];
export const DEFAULT_GAP_WINDOW: GapWindow = 30;

export function parseGapWindow(raw: string | null): GapWindow {
  if (raw === 'all') return null;
  const value = Number(raw);
  return (GAP_WINDOWS as readonly (number | null)[]).includes(value)
    ? (value as GapWindow)
    : DEFAULT_GAP_WINDOW;
}

export function gapWindowParam(window: GapWindow): string {
  return window === null ? 'all' : String(window);
}

export function gapWindowLabel(window: GapWindow): string {
  return window === null ? translateNow('agents.allTime') || 'All time' : `Last ${window} days`;
}

// ── Re-crawl ───────────────────────────────────────────────────────────────

export type RecrawlMode = 'full' | 'delta';

/**
 * Plans whose API will actually run a delta ("updated pages only") re-crawl.
 *
 * Mirrors `plan_service._DELTA_RECRAWL_PLAN_SLUGS`, which is a bare membership
 * test — not the `planIncludes` ladder, whose fall-through hands an unrecognised
 * bespoke slug every feature. A bespoke contract gets a full re-crawl here
 * exactly as the server gives it one, because a UI that promises the cheaper
 * crawl and then bills for the expensive one is worse than not offering it.
 */
const DELTA_RECRAWL_SLUGS: ReadonlySet<string> = new Set(['standard', 'professional', 'enterprise']);

export function canUseDeltaRecrawl(planSlug: string): boolean {
  return DELTA_RECRAWL_SLUGS.has(planSlug);
}

/** The server's `POST /crawl/diff` payload, narrowed. */
export interface RecrawlDiffData {
  sitemapTotal: number;
  existingTotal: number;
  unchanged: number;
  newPages: number;
  removedPages: number;
  unchangedUrls: string[];
  newUrls: string[];
  removedUrls: string[];
  costPerPage: number;
  balance: number;
  capped: boolean;
  /** The liveness pass gave up, so `removedPages` is a floor, not a count. */
  headPartial: boolean;
  /** The plan's per-crawl page ceiling. `-1` when the plan has none. */
  planMax: number;
}

export interface RecrawlDiff extends RecrawlDiffData {
  mode: RecrawlMode;
  sourceName: string;
  crawlUrl: string;
  replaceSource: string;
}

/**
 * What a full re-crawl will actually fetch, and what it will cost.
 *
 * The crawl set is *new + unchanged*, never `sitemap_total`. Those buckets are
 * disjoint by construction and together are every page that gets scraped, while
 * `sitemap_total` is only what discovery could see this minute. When discovery
 * times out the endpoint still answers 200 with `sitemap_total: 0` — and the
 * server's own `credits_required_full` is derived from that zero, so trusting it
 * would print "this will charge 0 credits" over a re-crawl that force-reingests
 * and re-bills every stored page.
 */
export function recrawlCost(diff: RecrawlDiff): { pages: number; credits: number } {
  const pages = diff.unchanged + diff.newPages;
  return { pages, credits: pages * diff.costPerPage };
}

/**
 * Why a full re-crawl must not be started, in the customer's words — or null.
 *
 * Discovery that *succeeded* and found nothing means the sitemap was briefly
 * unavailable: we do not know the site's page set, and a full re-crawl with
 * `force_reingest` would silently re-scrape and re-bill every stale stored URL.
 * A preview that explicitly *failed* is exempt: that path deliberately proceeds
 * with no URL list so the backend rediscovers the site itself.
 */
export function recrawlBlockedReason(diff: RecrawlDiff, previewFailed: boolean): string | null {
  if (previewFailed) return null;
  if (diff.mode === 'full' && diff.sitemapTotal === 0) {
    return translateNow('agents.weCouldNotSeeAny') || 'We could not see any pages on that site just now — its sitemap may be temporarily unavailable. Nothing has been charged. Try again in a few minutes.';
  }
  return null;
}

/**
 * The exact page list to re-crawl, or `null` to let the backend rediscover.
 *
 * The preview's URL buckets are capped at 500 while their counts are complete,
 * so a large site's list is a slice of the real crawl set. Passing a slice as
 * authoritative silently skips every page past the cap — an under-refresh the
 * customer would never see, on the one operation whose whole purpose is to be
 * up to date. When either bucket is short of its own count, or discovery itself
 * was capped, we send nothing and let the crawler enumerate the site.
 */
export function orderedUrlsForRecrawl(diff: RecrawlDiff): string[] | null {
  const truncated =
    diff.newUrls.length < diff.newPages || diff.unchangedUrls.length < diff.unchanged;
  if (diff.capped || truncated) return null;
  const urls = Array.from(new Set([...diff.newUrls, ...diff.unchangedUrls])).filter(Boolean);
  return urls.length > 0 ? urls : null;
}

// ── Crawl pre-flight ───────────────────────────────────────────────────────

export interface CrawlBudget {
  /** Pages found by discovery. */
  found: number;
  /** Discovery hit its ceiling, so there may be more. */
  capped: boolean;
  /** Credits per page, from the server's own pricing config — never hardcoded. */
  costPerPage: number;
  /** Credit balance of the ledger this crawl will actually drain. */
  balance: number;
  /** How many pages the balance covers. */
  affordablePages: number;
  /** The plan's per-crawl page ceiling, or `null` when the plan has none. */
  perCrawlLimit: number | null;
}

export function crawlBudgetOf(discovery: CrawlDiscovery): CrawlBudget {
  const costPerPage = Math.max(1, discovery.cost_per_page ?? 1);
  const balance = discovery.balance ?? 0;
  const planMax = discovery.plan_max;
  return {
    found: discovery.total_found,
    capped: discovery.capped,
    costPerPage,
    balance,
    affordablePages: discovery.max_affordable_pages ?? Math.floor(balance / costPerPage),
    perCrawlLimit: planMax === undefined || planMax === UNLIMITED || planMax < 0 ? null : planMax,
  };
}

/**
 * What stops this crawl from being started, or null.
 *
 * Ordered by what the customer can act on: a selection they can shrink comes
 * before a plan they would have to buy. Both are answered here, before the
 * request — the console this replaces started the crawl, took the 403 or the
 * 402, and rendered the raw server sentence.
 */
export function crawlPreflight(
  budget: CrawlBudget,
  selectedPages: number,
  planSlug?: string,
): { blocked: boolean; message: string | null } {
  if (selectedPages <= 0) {
    return { blocked: true, message: translateNow('agents.pickAtLeastOnePage') || 'Pick at least one page to train on.' };
  }
  if (budget.perCrawlLimit !== null && selectedPages > budget.perCrawlLimit) {
    // On the trial the cap is the thing being sold against, so the sentence
    // names what the site actually has and what the trial covers, rather than
    // asking the customer to work out the shortfall. On a paid tier the
    // actionable move is still to deselect, so that phrasing stays.
    return {
      blocked: true,
      message:
        planSlug === 'trial'
          ? `Your site has ${budget.found} pages. Your trial trains ${budget.perCrawlLimit}. Upgrade to train them all, or deselect ${selectedPages - budget.perCrawlLimit} to continue now.`
          : `Your plan trains up to ${budget.perCrawlLimit} pages in one go. Deselect ${selectedPages - budget.perCrawlLimit} to continue, or move to a plan with no per-crawl limit.`,
    };
  }
  if (selectedPages > budget.affordablePages) {
    return {
      blocked: false,
      message: `Your credits cover ${budget.affordablePages} of these ${selectedPages} pages. We train them in order and stop when the credits run out — nothing is charged twice.`,
    };
  }
  return { blocked: false, message: null };
}

// ── Upload ingestion ───────────────────────────────────────────────────────

export const UPLOAD_EXTENSIONS = ['.pdf', '.docx', '.txt', '.md'] as const;
/** Mirrors `_MAX_FILE_SIZE` in `document_routes.py`. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Mirrors `_MAX_FILES_PER_REQUEST`. */
export const MAX_UPLOAD_FILES = 20;

export type IngestPhase = 'queued' | 'working' | 'done' | 'failed' | 'unknown';

export interface IngestProgress {
  phase: IngestPhase;
  /** One line, in the customer's terms. */
  label: string;
  /** True while the job is still moving — the caller keeps polling. */
  active: boolean;
}

/**
 * An ARQ job state, read as something a customer can understand.
 *
 * `not_found` is not a failure: ARQ drops finished job records after its
 * retention window, so a job polled late has simply aged out. Calling that
 * "failed" would tell a customer their upload broke when it worked.
 */
export function ingestProgress(status: string | null): IngestProgress {
  switch (status) {
    case 'queued':
      return { phase: 'queued', label: translateNow('agents.waitingToStart') || 'Waiting to start', active: true };
    case 'in_progress':
      return { phase: 'working', label: translateNow('agents.readingYourDocument') || 'Reading your document', active: true };
    case 'complete':
      return { phase: 'done', label: translateNow('agents.readyToAnswerFrom') || 'Ready to answer from', active: false };
    case 'failed':
      return { phase: 'failed', label: translateNow('agents.weCouldNotReadThis') || 'We could not read this document', active: false };
    default:
      return { phase: 'unknown', label: translateNow('agents.processingInTheBackground') || 'Processing in the background', active: false };
  }
}

/** Human wording for the skip reasons the cost preview returns per file. */
export function uploadSkipReason(reason: string | undefined): string | null {
  if (!reason) return null;
  switch (reason) {
    case 'unsupported_type':
      return translateNow('agents.notAFileTypeWe') || 'Not a file type we can read — skipped, no charge';
    case 'oversize_file':
      return translateNow('agents.over10MbSkippedNo') || 'Over 10 MB — skipped, no charge';
    case 'batch_oversize':
      return translateNow('agents.thisBatchIsOver60') || 'This batch is over 60 MB — skipped, no charge';
    case 'extraction_failed':
      return translateNow('agents.noReadableTextMostLikely') || 'No readable text, most likely a scanned PDF — skipped, no charge';
    case 'extraction_error':
      return translateNow('agents.weCouldNotExtractText') || 'We could not extract text — skipped, no charge';
    default:
      return reason;
  }
}
