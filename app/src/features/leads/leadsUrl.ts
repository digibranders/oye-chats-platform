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
import { TIER_ORDER, type ContactFilter, type TierKey } from './leadModel';

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
    ('minScore' in patch && patch.minScore !== current.minScore);

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
    state.minScore !== null
  );
}

/** True when a filter runs in the browser rather than on the server. */
export function hasClientRefinement(state: LeadsUrlState): boolean {
  return state.query.trim() !== '' || state.contact !== 'all';
}
