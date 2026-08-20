import type { ReactNode } from 'react';
import { Alert, DataTable, LockedState, type Column, type SortState } from '../ui';
import type { PagedRows } from './recordListState';
import { isTruncated } from './recordListState';

export interface RecordListProps<T> {
  /** Names the table for assistive tech. Required by `DataTable`. */
  caption: string;
  columns: readonly Column<T>[];
  paged: PagedRows<T>;
  rowKey: (row: T) => string;
  pageSize?: number;
  loading?: boolean;
  error?: string | null;
  /** The server answered 403 for this list specifically. Renders the locked state. */
  forbidden?: boolean;
  onRetry?: () => void;
  empty?: ReactNode;
  onRowClick?: (row: T) => void;
  /**
   * How many rows the endpoint actually returned, and the hard cap it applies.
   *
   * Every `/superadmin/*` list in this console is capped server-side with no
   * paging parameter. When the response is exactly the cap, rows were silently
   * dropped and the reader has to be told — otherwise a total of "500" reads as
   * the platform's whole population.
   */
  loaded?: number;
  cap?: number;
  /** A standing caveat about the endpoint itself: fields it does not return, filters it does not accept. */
  note?: ReactNode;
}

/**
 * A record table, with the truths about its endpoint attached.
 *
 * The wrapper exists for one reason: these endpoints are inconsistent, capped,
 * and in places return fields the database does not have. A screen that renders
 * their output as a plain table is quietly wrong, and it is wrong in the
 * direction that matters — it under-reports. Every caveat that applies to a list
 * is rendered above it, in the same place, every time.
 */
export function RecordList<T>({
  caption,
  columns,
  paged,
  rowKey,
  pageSize = 25,
  loading = false,
  error = null,
  forbidden = false,
  onRetry,
  empty,
  onRowClick,
  loaded,
  cap,
  note,
}: RecordListProps<T>) {
  const truncated = loaded !== undefined && cap !== undefined && isTruncated(loaded, cap);

  // Forbidden is not an error. A super-admin's permissions are checked per route
  // on the server, so a single list inside a page they can otherwise read can
  // come back 403 — and "we could not load this" would send them to look for an
  // outage that is not there.
  if (forbidden) {
    return (
      <LockedState
        title="You do not have access to these records"
        description="Your super-admin account is not permitted to read this list. Nothing was loaded, and nothing on this page is missing for any other reason."
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {note ? <Alert tone="neutral">{note}</Alert> : null}
      {truncated ? (
        <Alert tone="warning" title="This is not the whole set">
          The endpoint returns at most {cap} rows and accepts no page parameter, so it answered with
          exactly {cap}. Older records exist and are not reachable from here. Narrow the request with
          a server-side filter where one is offered.
        </Alert>
      ) : null}
      {/* `DataTable` prints a range only once there is more than one page, so a
          short list would otherwise carry no count at all — and every table in
          this console owes the reader one. */}
      {!loading && !error && paged.total <= pageSize ? (
        <p className="text-xs text-text-secondary">
          <span className="figure">{paged.total}</span> {paged.total === 1 ? 'record' : 'records'}
        </p>
      ) : null}
      <DataTable<T>
        caption={caption}
        columns={columns}
        rows={paged.rows}
        rowKey={rowKey}
        loading={loading}
        error={error}
        onRetry={onRetry}
        empty={empty}
        onRowClick={onRowClick}
        pageSize={pageSize}
        page={paged.page}
        onPageChange={paged.onPageChange}
        rowCount={paged.total}
        sort={paged.sort}
        onSortChange={(next: SortState | null) => paged.onSortChange(next)}
      />
    </div>
  );
}
