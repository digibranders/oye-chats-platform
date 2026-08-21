import type { ReactNode } from 'react';
import { Info } from 'lucide-react';
import { DataTable, Tooltip, type Column, type SortState } from '../ui';
import { FORBIDDEN_TITLE, forbiddenDescription } from './forbidden';
import { PAGE_SIZE, type PagedRows } from './recordListState';
import { isTruncated } from './recordListState';

export interface RecordListProps<T> {
  /** Names the table for assistive tech. Required by `DataTable`. */
  caption: string;
  columns: readonly Column<T>[];
  paged: PagedRows<T>;
  rowKey: (row: T) => string;
  pageSize?: number;
  /** What one row is — "subscription", "delivery". Never "row". */
  rowNoun?: string;
  rowNounPlural?: string;
  loading?: boolean;
  error?: string | null;
  /** The server answered 403 for this list specifically. Renders the locked state. */
  forbidden?: boolean;
  /** Names the list, for the forbidden state: "the subscription book". */
  what?: string;
  onRetry?: () => void;
  empty?: ReactNode;
  onRowClick?: (row: T) => void;
  /** Seated inside a `Card`, so the table drops its own surface. */
  seated?: boolean;
  /** A totals row, aligned with the columns it totals. */
  footer?: ReactNode;
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
  /**
   * A standing caveat about the endpoint itself: fields it does not return,
   * filters it does not accept.
   *
   * A tooltip, not a paragraph. Fifteen of these used to render as permanent
   * neutral `Alert`s on the sunken ground the table head already uses, so every
   * table in the console opened with a block of chrome the reader had to parse
   * before reaching a row. It is a caveat some readers need once; that is
   * exactly what a tooltip is for.
   */
  note?: string;
}

/**
 * A record table, with the truths about its endpoint attached.
 *
 * The wrapper exists for one reason: these endpoints are inconsistent, capped,
 * and in places return fields the database does not have. A screen that renders
 * their output as a plain table is quietly wrong, and it is wrong in the
 * direction that matters — it under-reports. Every caveat that applies to a list
 * is rendered in the same place, in the same shape, every time.
 *
 * The forbidden branch, the row count and the truncation notice all used to be
 * re-copied by hand at eleven call sites with eleven different wordings. Two of
 * the three now belong to `DataTable`; this holds the third.
 */
export function RecordList<T>({
  caption,
  columns,
  paged,
  rowKey,
  pageSize = PAGE_SIZE,
  rowNoun = 'record',
  rowNounPlural,
  loading = false,
  error = null,
  forbidden = false,
  what = 'this list',
  onRetry,
  empty,
  onRowClick,
  seated = false,
  footer,
  loaded,
  cap,
  note,
}: RecordListProps<T>) {
  const truncated = loaded !== undefined && cap !== undefined && isTruncated(loaded, cap);

  return (
    <div className="flex flex-col gap-2">
      {note || truncated ? (
        <div className="flex flex-wrap items-center justify-end gap-3">
          {truncated ? (
            <p className="text-xs text-warning">
              Most recent <span className="figure">{cap}</span> only — the endpoint takes no page
              parameter.
            </p>
          ) : null}
          {note ? (
            <Tooltip content={note}>
              <button
                type="button"
                aria-label={`About ${caption}`}
                className="-my-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-xs text-text-tertiary hover:text-text-primary"
              >
                <Info aria-hidden className="h-icon-sm w-icon-sm" />
              </button>
            </Tooltip>
          ) : null}
        </div>
      ) : null}
      <DataTable<T>
        caption={caption}
        columns={columns}
        rows={paged.rows}
        rowKey={rowKey}
        rowNoun={rowNoun}
        rowNounPlural={rowNounPlural}
        loading={loading}
        // Forbidden wins over the error it arrived as. A 403 comes back through
        // the same failure path as an outage, and "we could not load this" would
        // send an operator hunting one that is not there.
        error={forbidden ? null : error}
        onRetry={onRetry}
        empty={empty}
        seated={seated}
        footer={footer}
        forbidden={
          forbidden ? { title: FORBIDDEN_TITLE, description: forbiddenDescription(what) } : null
        }
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
