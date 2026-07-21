import { type KeyboardEvent, type ReactNode } from 'react';
import { cn } from '../lib/cn';

export type ColumnAlign = 'left' | 'center' | 'right';

export interface Column<T> {
  /** Property on the row used as the default cell value and the column key. */
  key: keyof T;
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
  className?: string;
}

const alignClass: Record<ColumnAlign, string> = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
};

/**
 * DataTable — a lightweight, typed, accessible table (mandate shared
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
  className,
}: DataTableProps<T>) {
  const interactive = Boolean(onRowClick);

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
        'w-full overflow-x-auto rounded-xl border border-[var(--ds-border)] bg-[var(--ds-bg-surface)]',
        className,
      )}
    >
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
                  <span className="text-[13px] text-[var(--ds-text-muted)]">No data yet.</span>
                )}
              </td>
            </tr>
          ) : (
            rows.map((row, index) => (
              <tr
                key={rowKey ? rowKey(row, index) : index}
                onClick={onRowClick ? () => onRowClick(row, index) : undefined}
                onKeyDown={interactive ? (event) => handleKeyDown(event, row, index) : undefined}
                tabIndex={interactive ? 0 : undefined}
                role={interactive ? 'button' : undefined}
                className={cn(
                  'border-b border-[var(--ds-border)] last:border-0',
                  interactive &&
                    'cursor-pointer transition-colors hover:bg-[var(--ds-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ds-ring)]',
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
                      : (row[column.key] as ReactNode)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
