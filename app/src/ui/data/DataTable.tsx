import { useId, useMemo, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsUpDown } from 'lucide-react';
import { cn } from '../lib/cn';
import { Button } from '../primitives/Button';
import { Checkbox } from '../primitives/Toggle';
import { Skeleton } from '../primitives/Skeleton';
import { EmptyState, ErrorState } from './States';

export type SortDirection = 'asc' | 'desc';
export interface SortState {
  key: string;
  direction: SortDirection;
}

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  align?: 'left' | 'right';
  /** A CSS width, e.g. `'12rem'`. Omit to let the column take what it needs. */
  width?: string;
  /**
   * Make the column sortable. Supply a comparator for client-side sorting, or
   * pass `true` and handle `onSortChange` yourself for a server-sorted table.
   */
  sortable?: boolean | ((a: T, b: T) => number);
  /**
   * Pin the column to the left edge while the rest scrolls under it.
   *
   * On a wide table, scrolling right and no longer knowing whose row you are on
   * is how the wrong record gets edited.
   */
  pinned?: boolean;
  /** Hide below `md`. For columns that are context rather than the point. */
  secondary?: boolean;
}

export interface DataTableProps<T> {
  columns: readonly Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  /** Names the table for assistive tech. Required. */
  caption: string;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  empty?: ReactNode;

  /** Opens the row's detail. Adds a real focusable control, not a role on the `tr`. */
  onRowClick?: (row: T) => void;

  sort?: SortState | null;
  onSortChange?: (sort: SortState | null) => void;

  /** Enables the selection column. Omit for a read-only table. */
  selectedKeys?: ReadonlySet<string>;
  onSelectionChange?: (keys: Set<string>) => void;
  /** Shown above the table once anything is selected. */
  bulkActions?: ReactNode;

  /** Client-side paging. Omit for an unpaged or server-paged table. */
  pageSize?: number;
  className?: string;
}

function SortIcon({ state }: { state: SortDirection | null }) {
  if (state === 'asc') return <ArrowUp aria-hidden className="h-3 w-3 shrink-0" />;
  if (state === 'desc') return <ArrowDown aria-hidden className="h-3 w-3 shrink-0" />;
  return (
    <ChevronsUpDown
      aria-hidden
      className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-50"
    />
  );
}

/**
 * The console's table.
 *
 * Three structural decisions worth stating, because each replaces something the
 * previous table got wrong:
 *
 * 1. **A row is never given `role="button"`.** Doing so replaces the row's
 *    implicit `role="row"`, which drops it out of the table's accessibility tree
 *    entirely — no row/column position, no header association, no "row 3 of 40".
 *    Row activation is carried by a real control inside the first cell, so the
 *    table stays a table.
 * 2. **`border-separate` with hairlines painted as inset shadows.** In
 *    `border-collapse` mode the table paints cell borders rather than the cells,
 *    so a sticky header or a pinned column arrives with none of its own and the
 *    rest of the row shows through underneath it.
 * 3. **Sorting lives here.** The old table had no sort API at all, so every
 *    consumer shipped an unsortable list, while a fully sorted implementation
 *    sat unused in a dead directory.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  caption,
  loading = false,
  error = null,
  onRetry,
  empty,
  onRowClick,
  sort = null,
  onSortChange,
  selectedKeys,
  onSelectionChange,
  bulkActions,
  pageSize,
  className,
}: DataTableProps<T>) {
  const captionId = useId();
  const [page, setPage] = useState(0);

  const selectable = Boolean(selectedKeys && onSelectionChange);

  const sortedRows = useMemo(() => {
    if (!sort) return rows;
    const column = columns.find((candidate) => candidate.key === sort.key);
    // A `sortable: true` column is server-sorted: the rows arrive in order and
    // re-sorting them here would fight the server.
    if (typeof column?.sortable !== 'function') return rows;
    const comparator = column.sortable;
    const next = [...rows].sort(comparator);
    return sort.direction === 'desc' ? next.reverse() : next;
  }, [rows, sort, columns]);

  const pageCount = pageSize ? Math.max(1, Math.ceil(sortedRows.length / pageSize)) : 1;
  const safePage = Math.min(page, pageCount - 1);
  const visibleRows = pageSize
    ? sortedRows.slice(safePage * pageSize, safePage * pageSize + pageSize)
    : sortedRows;

  function toggleSort(key: string) {
    if (!onSortChange) return;
    // asc → desc → unsorted. The third press has to exist: without it there is
    // no way back to the server's own ordering, which is usually the meaningful
    // one (most recent first).
    if (sort?.key !== key) onSortChange({ key, direction: 'asc' });
    else if (sort.direction === 'asc') onSortChange({ key, direction: 'desc' });
    else onSortChange(null);
  }

  function toggleRow(key: string) {
    if (!selectedKeys || !onSelectionChange) return;
    const next = new Set(selectedKeys);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onSelectionChange(next);
  }

  function toggleAllOnPage() {
    if (!selectedKeys || !onSelectionChange) return;
    const keys = visibleRows.map(rowKey);
    const allSelected = keys.every((key) => selectedKeys.has(key));
    const next = new Set(selectedKeys);
    // Scoped to the current page, because "select all" that silently reaches
    // rows the user cannot see is how a bulk delete goes wrong.
    keys.forEach((key) => (allSelected ? next.delete(key) : next.add(key)));
    onSelectionChange(next);
  }

  const pageKeys = visibleRows.map(rowKey);
  const allOnPageSelected = pageKeys.length > 0 && pageKeys.every((key) => selectedKeys?.has(key));
  const someOnPageSelected = pageKeys.some((key) => selectedKeys?.has(key));
  const selectedCount = selectedKeys?.size ?? 0;

  const colSpan = columns.length + (selectable ? 1 : 0);

  return (
    <div className={cn('overflow-hidden rounded-lg border border-border bg-surface', className)}>
      {selectable && selectedCount > 0 ? (
        <div className="flex flex-wrap items-center gap-3 border-b border-border bg-accent-50 px-4 py-2">
          <p className="text-sm font-medium text-accent-700">
            <span className="tnum">{selectedCount}</span> selected
          </p>
          <div className="flex flex-wrap items-center gap-2">{bulkActions}</div>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => onSelectionChange?.(new Set())}
          >
            Clear
          </Button>
        </div>
      ) : null}

      <div className="overflow-x-auto">
        <table className="console-table w-full text-left">
          <caption id={captionId} className="sr-only">
            {caption}
          </caption>
          <thead className="bg-surface-sunken">
            <tr>
              {selectable ? (
                <th scope="col" className="w-10 px-4 py-2.5">
                  <Checkbox
                    checked={allOnPageSelected ? true : someOnPageSelected ? 'indeterminate' : false}
                    onCheckedChange={toggleAllOnPage}
                    aria-label={allOnPageSelected ? 'Clear selection on this page' : 'Select all rows on this page'}
                  />
                </th>
              ) : null}
              {columns.map((column) => {
                const isSorted = sort?.key === column.key;
                const direction = isSorted ? sort.direction : null;
                return (
                  <th
                    key={column.key}
                    scope="col"
                    style={column.width ? { width: column.width } : undefined}
                    // `aria-sort` is what makes the sort state audible; the arrow
                    // glyph alone tells a screen-reader user nothing.
                    aria-sort={
                      isSorted ? (direction === 'asc' ? 'ascending' : 'descending') : undefined
                    }
                    className={cn(
                      'whitespace-nowrap px-4 py-2.5 font-mono text-2xs font-medium uppercase tracking-[0.08em] text-text-tertiary',
                      column.align === 'right' && 'text-right',
                      column.pinned && 'is-pinned sticky left-0 z-10 bg-surface-sunken',
                      column.secondary && 'hidden md:table-cell',
                    )}
                  >
                    {column.sortable && onSortChange ? (
                      <button
                        type="button"
                        onClick={() => toggleSort(column.key)}
                        className={cn(
                          'group inline-flex items-center gap-1 rounded-xs uppercase tracking-[0.08em]',
                          'transition-colors hover:text-text-primary',
                          column.align === 'right' && 'flex-row-reverse',
                        )}
                      >
                        {column.header}
                        <SortIcon state={direction} />
                      </button>
                    ) : (
                      column.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>

          <tbody>
            {loading ? (
              Array.from({ length: 6 }, (_, index) => (
                <tr key={`skeleton-${index}`}>
                  {selectable ? (
                    <td className="px-4 py-3">
                      <Skeleton className="h-4 w-4" />
                    </td>
                  ) : null}
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      className={cn('px-4 py-3', column.secondary && 'hidden md:table-cell')}
                    >
                      <Skeleton className="h-3 w-full max-w-[10rem]" />
                    </td>
                  ))}
                </tr>
              ))
            ) : error ? (
              <tr>
                <td colSpan={colSpan}>
                  <ErrorState description={error} onRetry={onRetry} />
                </td>
              </tr>
            ) : visibleRows.length === 0 ? (
              <tr>
                <td colSpan={colSpan}>
                  {empty ?? <EmptyState title="Nothing to show" description="No rows matched." />}
                </td>
              </tr>
            ) : (
              visibleRows.map((row) => {
                const key = rowKey(row);
                const selected = selectedKeys?.has(key) ?? false;
                return (
                  <tr
                    key={key}
                    className={cn(
                      'transition-colors duration-[var(--dur-fast)]',
                      selected ? 'bg-accent-50' : 'hover:bg-surface-hover',
                    )}
                  >
                    {selectable ? (
                      <td className="px-4 py-2.5 align-middle">
                        <Checkbox
                          checked={selected}
                          onCheckedChange={() => toggleRow(key)}
                          aria-label={`Select row ${key}`}
                        />
                      </td>
                    ) : null}
                    {columns.map((column, columnIndex) => {
                      const content = column.render(row);
                      // The first cell carries row activation as a real button,
                      // so the row keeps its own semantics and the target is
                      // still the whole cell via the stretched pseudo-element.
                      const activates = onRowClick && columnIndex === 0;
                      return (
                        <td
                          key={column.key}
                          className={cn(
                            'px-4 py-2.5 align-middle text-sm text-text-primary',
                            column.align === 'right' && 'text-right tnum',
                            column.pinned &&
                              cn('is-pinned sticky left-0 z-10', selected ? 'bg-accent-50' : 'bg-surface'),
                            column.secondary && 'hidden md:table-cell',
                            activates && 'relative',
                          )}
                        >
                          {activates ? (
                            <button
                              type="button"
                              onClick={() => onRowClick(row)}
                              className="rounded-xs text-left after:absolute after:inset-0 after:content-['']"
                            >
                              {content}
                            </button>
                          ) : (
                            content
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {pageSize && !loading && !error && sortedRows.length > pageSize ? (
        <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-2.5">
          <p className="text-xs text-text-secondary">
            <span className="tnum">{safePage * pageSize + 1}</span>–
            <span className="tnum">{Math.min((safePage + 1) * pageSize, sortedRows.length)}</span> of{' '}
            <span className="tnum">{sortedRows.length}</span>
          </p>
          <div className="flex items-center gap-1">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Previous page"
              disabled={safePage === 0}
              onClick={() => setPage((current) => Math.max(0, current - 1))}
            >
              <ChevronLeft aria-hidden className="h-4 w-4" />
            </Button>
            <span className="px-1 text-xs text-text-secondary">
              <span className="tnum">{safePage + 1}</span> / <span className="tnum">{pageCount}</span>
            </span>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Next page"
              disabled={safePage >= pageCount - 1}
              onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
            >
              <ChevronRight aria-hidden className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
