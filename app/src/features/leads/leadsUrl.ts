/**
 * The Leads page's state, in the URL.
 *
 * Every filter, the sort, the page number, the open lead and which face of the
 * drawer is showing all live in the query string, so refresh, Back, and a link
 * pasted into a chat all land on the same view. The page this replaces held all
 * of it in `useState`: sharing "the four leads over 75 that came in yesterday"
 * meant describing it in prose.
 *
 * Defaults are never written. A URL with no query string is the default view,
 * which keeps a shared link readable and makes "is anything filtered?" a
 * question about the URL rather than about component state.
 */
import type { SortDirection, SortState } from '../../ui';
// The reporting-window vocabulary Analytics already owns (`7d|30d|90d|all`,
// the same keys `/analytics/qualification-funnel` speaks). Leads needs its
// own URL-persisted selection rather than a range handed down from a parent
// — `FeedbackPanel` is the existing precedent for a second feature reusing
// this module instead of re-deriving the same four options and labels.
import { RANGE_OPTIONS, resolveRange, type RangeKey } from '../analytics/range';
import { getLocale } from '../../i18n/i18n';
import { TIER_ORDER, type ContactFilter, type TierKey } from './leadModel';
import { t as translateNow } from '../../i18n/i18n';

/** Analytics' four presets, plus the one window it has no notion of: an
 * explicit calendar range. Kept local to Leads rather than folded into
 * `RangeKey` itself — Analytics has no "custom" concept and no UI for one. */
export type LeadsRangeKey = RangeKey | 'custom';

export const LEADS_RANGE_OPTIONS: ReadonlyArray<{ value: LeadsRangeKey; label: string }> = [
  ...RANGE_OPTIONS,
  { value: 'custom', label: 'Custom range' },
];

/** Which face of the drawer is showing. Both are always reachable from either. */
export type DrawerTab = 'profile' | 'conversation';

/** Column keys the table can sort by. Must match the `Column.key` values. */
export const SORT_KEYS = ['lead', 'company', 'quality', 'chats', 'last_active'] as const;
export type SortKey = (typeof SORT_KEYS)[number];

/** The score thresholds offered by the "minimum score" filter. */
export const MIN_SCORE_OPTIONS = [25, 50, 75] as const;

export interface LeadsUrlState {
  /** Narrows the rows already fetched. Not sent to the server. */
  query: string;
  /** Narrows the rows already fetched. Not sent to the server. */
  contact: ContactFilter;
  /** Sent to the server as `status`, which is its accepted alias for `tier`. */
  tier: TierKey | null;
  /** Sent to the server as `min_score`. */
  minScore: number | null;
  /**
   * Sent to the server as `days` (resolved via `resolveRange`), except
   * `'custom'`, which is sent as `from`/`to` instead — see `rangeFrom` /
   * `rangeTo`. `'all'` is the default — leads existed with no window filter
   * before this control, and this page must not silently start hiding rows
   * on a fresh URL.
   */
  range: LeadsRangeKey;
  /** `YYYY-MM-DD`, or `null` while unset. Only read when `range === 'custom'`. */
  rangeFrom: string | null;
  /** `YYYY-MM-DD`, or `null` while unset. Only read when `range === 'custom'`. */
  rangeTo: string | null;
  /** 1-based, matching the API. */
  page: number;
  sort: SortState | null;
  /** The open lead's session id, or `null` when the drawer is closed. */
  openLead: string | null;
  tab: DrawerTab;
}

export const DEFAULT_LEADS_URL_STATE: LeadsUrlState = {
  query: '',
  contact: 'all',
  tier: null,
  minScore: null,
  range: 'all',
  rangeFrom: null,
  rangeTo: null,
  page: 1,
  sort: null,
  openLead: null,
  tab: 'profile',
};

function readTier(raw: string | null): TierKey | null {
  return raw !== null && (TIER_ORDER as readonly string[]).includes(raw) ? (raw as TierKey) : null;
}

function readContact(raw: string | null): ContactFilter {
  return raw === 'named' || raw === 'anonymous' ? raw : 'all';
}

function readMinScore(raw: string | null): number | null {
  const parsed = Number(raw);
  // Anything outside the offered thresholds is dropped rather than clamped: a
  // hand-edited `?score=999` should show the unfiltered list, not an empty one.
  return (MIN_SCORE_OPTIONS as readonly number[]).includes(parsed) ? parsed : null;
}

function readRange(raw: string | null): LeadsRangeKey {
  // `parseRange` falls back to analytics's own default ('30d') for an
  // unrecognised value, which would silently start hiding this page's leads
  // on a bare `?range=bogus`. Leads' fallback is 'all', so it goes through
  // `LEADS_RANGE_OPTIONS` directly rather than through `parseRange`.
  return LEADS_RANGE_OPTIONS.some((option) => option.value === raw) ? (raw as LeadsRangeKey) : 'all';
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function readIsoDate(raw: string | null): string | null {
  // Dropped rather than clamped, matching `readMinScore`: a hand-edited
  // `?from=nonsense` should read as "no bound", not throw or fall back to a
  // date the URL never named.
  return raw && ISO_DATE.test(raw) && !Number.isNaN(Date.parse(raw)) ? raw : null;
}

function readPage(raw: string | null): number {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
}

function readSort(raw: string | null): SortState | null {
  if (!raw) return null;
  const [key, direction] = raw.split(':');
  if (!(SORT_KEYS as readonly string[]).includes(key)) return null;
  if (direction !== 'asc' && direction !== 'desc') return null;
  return { key, direction: direction as SortDirection };
}

export function readLeadsUrl(params: URLSearchParams): LeadsUrlState {
  return {
    query: params.get('q') ?? '',
    contact: readContact(params.get('who')),
    tier: readTier(params.get('tier')),
    minScore: readMinScore(params.get('score')),
    range: readRange(params.get('range')),
    rangeFrom: readIsoDate(params.get('from')),
    rangeTo: readIsoDate(params.get('to')),
    page: readPage(params.get('page')),
    sort: readSort(params.get('sort')),
    openLead: params.get('lead'),
    tab: params.get('tab') === 'conversation' ? 'conversation' : 'profile',
  };
}

/**
 * Fold a patch into the current state and serialise it.
 *
 * Any change to what the *set* of rows is resets the page, because page 4 of a
 * newly-filtered list is a different four leads from the ones the reader was
 * looking at — and usually does not exist. The caller can still set `page`
 * explicitly in the same patch; the explicit value wins.
 */
export function writeLeadsUrl(
  current: LeadsUrlState,
  patch: Partial<LeadsUrlState>,
): URLSearchParams {
  const changesResultSet =
    ('query' in patch && patch.query !== current.query) ||
    ('contact' in patch && patch.contact !== current.contact) ||
    ('tier' in patch && patch.tier !== current.tier) ||
    ('minScore' in patch && patch.minScore !== current.minScore) ||
    ('range' in patch && patch.range !== current.range) ||
    ('rangeFrom' in patch && patch.rangeFrom !== current.rangeFrom) ||
    ('rangeTo' in patch && patch.rangeTo !== current.rangeTo);

  const next: LeadsUrlState = {
    ...current,
    ...(changesResultSet ? { page: 1 } : null),
    ...patch,
  };

  const params = new URLSearchParams();
  if (next.query.trim()) params.set('q', next.query.trim());
  if (next.contact !== 'all') params.set('who', next.contact);
  if (next.tier) params.set('tier', next.tier);
  if (next.minScore !== null) params.set('score', String(next.minScore));
  if (next.range !== 'all') params.set('range', next.range);
  // Only meaningful for 'custom' — carrying a stale `from`/`to` once the
  // reader has picked back a preset would resurrect a bound the URL no
  // longer names anything about.
  if (next.range === 'custom') {
    if (next.rangeFrom) params.set('from', next.rangeFrom);
    if (next.rangeTo) params.set('to', next.rangeTo);
  }
  if (next.page > 1) params.set('page', String(next.page));
  if (next.sort) params.set('sort', `${next.sort.key}:${next.sort.direction}`);
  if (next.openLead) params.set('lead', next.openLead);
  // Only meaningful while a lead is open, and carrying it otherwise leaves a
  // stale `?tab=` on a link that opens no drawer.
  if (next.openLead && next.tab !== 'profile') params.set('tab', next.tab);
  return params;
}

/** Are any filters narrowing the list? Drives the "clear filters" affordance. */
export function hasActiveFilters(state: LeadsUrlState): boolean {
  return (
    state.query.trim() !== '' ||
    state.contact !== 'all' ||
    state.tier !== null ||
    state.minScore !== null ||
    state.range !== 'all'
  );
}

/** The server-side shape of the date window: either a trailing `days` count
 * (the four presets) or an explicit `from`/`to` (custom) — never both, and
 * `days` for `'all'` is `null`, meaning "send no filter", not "send a huge
 * one". Mirrors `_resolve_window` in `lead_routes.py`. */
export interface LeadsWindow {
  days: number | null;
  from: string | null;
  to: string | null;
}

export function leadsRangeWindow(
  state: Pick<LeadsUrlState, 'range' | 'rangeFrom' | 'rangeTo'>,
): LeadsWindow {
  if (state.range === 'custom') {
    return { days: null, from: state.rangeFrom, to: state.rangeTo };
  }
  return { days: resolveRange(state.range).days, from: null, to: null };
}

function formatIsoDate(iso: string): string {
  // Not `formatDate` from `ui/lib/formatters`: it parses via `new Date(iso)`,
  // which reads a bare `YYYY-MM-DD` as UTC midnight — a reader west of UTC
  // sees the day before the one they picked. Building the `Date` from the
  // parsed Y/M/D components, in local time, is what the native constructor's
  // `(year, month, day)` overload is for.
  const [year, month, day] = iso.split('-').map(Number);
  return new Intl.DateTimeFormat(getLocale() || undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(year, month - 1, day));
}

/** What the `StatRow` caption and the toolbar's info tooltip say the window
 * is. A custom range with only one bound set reads as "Since …" / "Through
 * …" rather than a dash to nowhere. */
export function leadsRangeLabel(
  state: Pick<LeadsUrlState, 'range' | 'rangeFrom' | 'rangeTo'>,
): string {
  if (state.range !== 'custom') return resolveRange(state.range).label;
  const { rangeFrom, rangeTo } = state;
  if (rangeFrom && rangeTo) return `${formatIsoDate(rangeFrom)} to ${formatIsoDate(rangeTo)}`;
  if (rangeFrom) return `Since ${formatIsoDate(rangeFrom)}`;
  if (rangeTo) return `Through ${formatIsoDate(rangeTo)}`;
  return translateNow('leads.customRange') || 'Custom range';
}

/** True when a filter runs in the browser rather than on the server. */
export function hasClientRefinement(state: LeadsUrlState): boolean {
  return state.query.trim() !== '' || state.contact !== 'all';
}
