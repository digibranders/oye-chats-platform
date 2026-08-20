import type { SortState } from '../ui';
import type { UrlState } from './usePlatform';

/**
 * List plumbing for the platform console's record tables.
 *
 * Every `/superadmin/*` list endpoint in the customers and records sections
 * answers with a **bare, server-capped array** and accepts no `page` or `limit`
 * parameter — `superadmin_routes_v2.py` caps at 500 (200 for documents,
 * 100 for the live queue), `superadmin_ops_routes.py` at 500. There is no
 * server pagination contract to wire, so the honest thing is to page the
 * complete set the endpoint returned, in the URL, and to say plainly when that
 * set was truncated at the server's cap.
 *
 * That is what this does: filter → sort → slice, over the **whole** response,
 * with the page and the sort held in the query string so a filtered list is a
 * link. `DataTable` is then driven in its controlled `page`/`rowCount` mode,
 * which is exactly correct — it is handed one page and told the real total,
 * and it never re-sorts the slice behind our back.
 *
 * It is emphatically *not* a client-side pager over one page of a large set.
 * When `items.length` reaches the endpoint's cap, `isTruncated` is true and the
 * screen says so rather than reporting "1–50 of 500" for a platform with
 * nine thousand rows.
 */

/**
 * Rows per page, everywhere in this console.
 *
 * One number, not six. The console shipped 10, 12, 14, 25 and 50 across its
 * tables, so a reconciliation table capped at ten rows meant three page clicks
 * per invariant, six invariants deep, while the invoice book next door showed
 * fifty. Fifty rows at the dense row height is about a screen and a half of
 * scroll, which is the right trade for a tool whose job is scanning.
 */
export const PAGE_SIZE = 50;

/** `key:asc` / `key:desc`, as carried in the query string. */
export function parseSort(raw: string): SortState | null {
  if (!raw) return null;
  const [key, direction] = raw.split(':');
  if (!key) return null;
  if (direction !== 'asc' && direction !== 'desc') return null;
  return { key, direction };
}

export function formatSort(sort: SortState | null): string | null {
  return sort ? `${sort.key}:${sort.direction}` : null;
}

export interface Comparator<T> {
  (a: T, b: T): number;
  /**
   * Whether the row has a value for this column at all.
   *
   * Rows without one are held out of the sort and appended, so an absent value
   * is last in **both** directions. Negating a comparator that merely returns
   * `1` for an absent value flips that rule on the descending press, which puts
   * a column of em dashes at the top of the table — the opposite of what the
   * reader asked to see.
   */
  present?: (row: T) => boolean;
}

function withPresence<T>(compare: (a: T, b: T) => number, present: (row: T) => boolean): Comparator<T> {
  const comparator = compare as Comparator<T>;
  comparator.present = present;
  return comparator;
}

/**
 * Order rows by a registered comparator.
 *
 * An unknown key returns the rows untouched rather than throwing: a stale sort
 * pasted in from a URL for a column that no longer exists must degrade to the
 * server's own ordering, not blank the table.
 */
export function applySort<T>(
  rows: readonly T[],
  sort: SortState | null,
  comparators: Record<string, Comparator<T>>,
): T[] {
  if (!sort) return rows.slice();
  const comparator = comparators[sort.key];
  if (!comparator) return rows.slice();
  const direction = sort.direction === 'desc' ? -1 : 1;
  // Multiply rather than reverse: `.reverse()` also flips tied rows, so the
  // descending order is not the mirror of the ascending one and rows appear to
  // shuffle. `Array.prototype.sort` is stable, so ties keep the server's order.
  const ordered = (subset: readonly T[]) =>
    subset.slice().sort((a, b) => direction * comparator(a, b));

  const { present } = comparator;
  if (!present) return ordered(rows);
  return [...ordered(rows.filter((row) => present(row))), ...rows.filter((row) => !present(row))];
}

/** One 1-based page. Clamped, so a page number out of a shared URL cannot blank the table. */
export function pageSlice<T>(rows: readonly T[], page: number, pageSize: number): T[] {
  const pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  const safe = Math.min(Math.max(1, Math.trunc(page) || 1), pageCount);
  return rows.slice((safe - 1) * pageSize, safe * pageSize);
}

/** Case-insensitive substring match across a row's searchable fields. */
export function includesText(fields: readonly (string | number | null | undefined)[], query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return fields.some((field) => field != null && String(field).toLowerCase().includes(needle));
}

/* ------------------------------------------------------------- comparators */

/** Locale-aware. Absent values are held out of the sort and appended. */
export function byText<T>(get: (row: T) => string | null | undefined): Comparator<T> {
  return withPresence(
    (a, b) => (get(a) ?? '').localeCompare(get(b) ?? '', undefined, { sensitivity: 'base' }),
    (row) => Boolean(get(row)),
  );
}

export function byNumber<T>(get: (row: T) => number | null | undefined): Comparator<T> {
  return withPresence(
    (a, b) => (get(a) ?? 0) - (get(b) ?? 0),
    (row) => {
      const value = get(row);
      return value != null && Number.isFinite(value);
    },
  );
}

/** ISO timestamps. An unparseable or missing date is appended, never treated as epoch zero. */
export function byDate<T>(get: (row: T) => string | null | undefined): Comparator<T> {
  const at = (row: T) => Date.parse(get(row) ?? '');
  return withPresence(
    (a, b) => at(a) - at(b),
    (row) => Number.isFinite(at(row)),
  );
}

/* -------------------------------------------------------------------- hook */

export interface PagedRows<T> {
  /** Exactly the current page. Hand this straight to `DataTable`. */
  rows: T[];
  /** 1-based, read from the URL. */
  page: number;
  /** Rows matching the filter, across every page. `DataTable`'s `rowCount`. */
  total: number;
  onPageChange: (page: number) => void;
  sort: SortState | null;
  onSortChange: (sort: SortState | null) => void;
}

export interface PagedRowsOptions<T> {
  url: UrlState;
  pageSize?: number;
  pageKey?: string;
  sortKey?: string;
  /** Applied to the whole set before sorting and paging. */
  filter?: (row: T) => boolean;
  comparators?: Record<string, Comparator<T>>;
}

/**
 * Filter, sort and page a complete result set, with the page and the sort in
 * the URL.
 *
 * Not memoised. The sets are bounded by the server's own cap (≤ 500 rows), and
 * a `useMemo` keyed on an inline `filter` closure would recompute on every
 * render anyway while implying it does not.
 */
export function usePagedRows<T>(
  all: readonly T[],
  { url, pageSize = PAGE_SIZE, pageKey = 'page', sortKey = 'sort', filter, comparators = {} }: PagedRowsOptions<T>,
): PagedRows<T> {
  const page = url.getNumber(pageKey, 1);
  const sort = parseSort(url.get(sortKey));
  const filtered = filter ? all.filter(filter) : all;
  const sorted = applySort(filtered, sort, comparators);

  return {
    rows: pageSlice(sorted, page, pageSize),
    page,
    total: sorted.length,
    sort,
    onPageChange: (next) => url.set({ [pageKey]: next }),
    // Changing the sort returns to page one: page 4 of the old order holds
    // different rows in the new one, which reads as the sort having failed.
    onSortChange: (next) => url.set({ [sortKey]: formatSort(next), [pageKey]: null }),
  };
}

/**
 * True when a response is exactly the size of the endpoint's server-side cap,
 * which is the only signal these endpoints give that rows were dropped.
 */
export function isTruncated(count: number, cap: number): boolean {
  return count >= cap;
}
