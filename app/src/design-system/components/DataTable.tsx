import { type KeyboardEvent, type ReactNode, useState } from 'react';
import { cn } from '../lib/cn';
import { useTranslation } from '../../i18n/useTranslation';

export type ColumnAlign = 'left' | 'center' | 'right';

export interface Column<T> {
  /**
   * Column identity. A `keyof T` doubles as the default cell value (`row[key]`);
   * a plain `string` lets purely presentational columns (actions, computed
   * cells with their own `render`) carry a stable key without borrowing an
   * unrelated data field.
   */
  key: keyof T | string;
  /** Column header. */
  header: ReactNode;
  /** Custom cell renderer. Falls back to the raw `row[key]` value. */
  render?: (row: T, rowIndex: number) => ReactNode;
  /** Horizontal alignment for header + cells. Defaults to `left`. */
  align?: ColumnAlign;
  /** Optional fixed/allocated width, e.g. "12rem" or "20%". */
  width?: string;
  /** Extra classes applied to the cell (not the header). */
  cellClassName?: string;
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  /** Stable row key. Falls back to the row index. */
  rowKey?: (row: T, index: number) => string | number;
  /** Rendered in place of the table body when there are no rows. */
  empty?: ReactNode;
  /** Makes rows interactive (keyboard + pointer). */
  onRowClick?: (row: T, index: number) => void;
  /** Accessible name / summary for the table. */
  caption?: string;
  /** When set, paginate to this many rows per page and render a pager footer.
   *  Omit for the default behavior (render every row, no pager). */
  pageSize?: number;
  className?: string;
}

const alignClass: Record<ColumnAlign, string> = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
};

/**
 * DataTable - a lightweight, typed, accessible table (mandate shared
 * component). No external table library: a semantic `<table>` with per-column
 * render functions and optional row interaction. Horizontally scrollable so it
 * never breaks the page on narrow viewports.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  empty,
  onRowClick,
  caption,
  pageSize,
  className,
}: DataTableProps<T>) {
  const { t } = useTranslation();
  const interactive = Boolean(onRowClick);

  // Opt-in pagination. When `pageSize` is set, only that many rows render and a
  // pager footer appears; otherwise every row renders (default behavior).
  const paginated = typeof pageSize === 'number' && pageSize > 0;
  const total = rows.length;
  const pageCount = paginated ? Math.max(1, Math.ceil(total / (pageSize as number))) : 1;
  const [page, setPage] = useState(0);
  // Filters/search shrink `rows`; snap back to the first page when the row set
  // or page size changes. Done by adjusting state during render (the sanctioned
  // React pattern) rather than in an effect, so the pager never strands on an
  // out-of-range page after a filter narrows the results.
  const resetKey = `${total}:${pageSize ?? ''}`;
  const [seenResetKey, setSeenResetKey] = useState(resetKey);
  if (resetKey !== seenResetKey) {
    setSeenResetKey(resetKey);
    setPage(0);
  }
  const safePage = Math.min(page, pageCount - 1);
  const visibleRows = paginated
    ? rows.slice(safePage * (pageSize as number), safePage * (pageSize as number) + (pageSize as number))
    : rows;
  const rangeStart = total === 0 ? 0 : safePage * (pageSize as number) + 1;
  const rangeEnd = paginated ? Math.min((safePage + 1) * (pageSize as number), total) : total;

  function handleKeyDown(event: KeyboardEvent<HTMLTableRowElement>, row: T, index: number): void {
    if (!onRowClick) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onRowClick(row, index);
    }
  }

  return (
    <div
      className={cn(
        'w-full rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)]',
        className,
      )}
    >
      <div className="w-full overflow-x-auto">
      <table className="w-full border-collapse text-left text-[13px]">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr className="border-b border-[var(--ds-border)]">
            {columns.map((column) => (
              <th
                key={String(column.key)}
                scope="col"
                style={column.width ? { width: column.width } : undefined}
                className={cn(
                  'whitespace-nowrap px-4 py-3 text-[11px] font-semibold uppercase tracking-wide text-[var(--ds-text-subtle)]',
                  alignClass[column.align ?? 'left'],
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="px-4 py-10 text-center">
                {empty ?? (
                  <span className="text-[13px] text-[var(--ds-text-muted)]">
                    {t('ds.table.empty') || 'No data yet.'}
                  </span>
                )}
              </td>
            </tr>
          ) : (
            visibleRows.map((row, index) => (
              <tr
                key={rowKey ? rowKey(row, index) : index}
                onClick={onRowClick ? () => onRowClick(row, index) : undefined}
                onKeyDown={interactive ? (event) => handleKeyDown(event, row, index) : undefined}
                tabIndex={interactive ? 0 : undefined}
                role={interactive ? 'button' : undefined}
                className={cn(
                  'border-b border-[var(--ds-border)] last:border-0',
                  interactive &&
                    'cursor-pointer transition-colors hover:bg-[var(--ds-bg-hover)] focus-visible:outline-none focus-visible:shadow-[0_0_0_1px_var(--ds-ring)]',
                )}
              >
                {columns.map((column) => (
                  <td
                    key={String(column.key)}
                    className={cn(
                      'px-4 py-3 align-middle text-[var(--ds-text)]',
                      alignClass[column.align ?? 'left'],
                      column.cellClassName,
                    )}
                  >
                    {column.render
                      ? column.render(row, index)
                      : (row[column.key as keyof T] as ReactNode)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
      </div>
      {paginated && total > 0 && (
        <div className="flex items-center justify-between gap-3 border-t border-[var(--ds-border)] px-4 py-2.5 text-[12px] text-[var(--ds-text-muted)]">
          <span>
            {rangeStart}&ndash;{rangeEnd} of {total}
          </span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={safePage <= 0}
              className="rounded-md px-2.5 py-1 font-medium text-[var(--ds-text)] transition-colors hover:bg-[var(--ds-bg-hover)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t('ds.table.previous') || 'Previous'}
            </button>
            <span className="px-1 tabular-nums text-[var(--ds-text-subtle)]">
              {safePage + 1} / {pageCount}
            </span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              disabled={safePage >= pageCount - 1}
              className="rounded-md px-2.5 py-1 font-medium text-[var(--ds-text)] transition-colors hover:bg-[var(--ds-bg-hover)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t('ds.table.next') || 'Next'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
