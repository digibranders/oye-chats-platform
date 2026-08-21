import {
  cloneElement,
  isValidElement,
  useCallback,
  useMemo,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, ChevronsUpDown } from 'lucide-react';
import { cn } from '../lib/cn';
import { Button } from '../primitives/Button';
import { Checkbox } from '../primitives/Toggle';
import { Skeleton } from '../primitives/Skeleton';
import { EmptyState, ErrorState, LockedState } from './States';

export type SortDirection = 'asc' | 'desc';
export interface SortState {
  key: string;
  direction: SortDirection;
}

/**
 * What kind of value the column holds — which decides its typeface, not its
 * position.
 *
 * The two were coupled before: `figure` was emitted only for `align: 'right'`,
 * so a left-aligned column of dates, ids or counts lost its mono (DESIGN.md
 * §1.3 — "every figure is mono") and 96 call sites worked around it by writing
 * `className="figure"` inside `render`, while a right-pushed status badge got
 * mono applied to it wrongly.
 */
export type ColumnType = 'text' | 'number' | 'id';

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  align?: 'left' | 'center' | 'right';
  /**
   * Drives the typeface, and the default alignment for `number` (right).
   *
   * Omit it and the legacy rule still applies — a right-aligned column is set
   * as a figure — so nothing that shipped before this existed changed.
   */
  type?: ColumnType;
  /**
   * A CSS width, e.g. `'12rem'`.
   *
   * Honoured as a hard width only when **every** column declares one: the table
   * then switches to `table-fixed`. Otherwise auto layout treats it as a
   * suggestion it may override from the cell contents, which is what the app's
   * 49 `width` declarations have always actually got.
   */
  width?: string;
  /**
   * Supply a comparator to make the column sortable client-side, or `true` for
   * a server-sorted table (the rows arrive in order; `onSortChange` tells the
   * caller what to ask for).
   */
  sortable?: boolean | ((a: T, b: T) => number);
  /**
   * Pin the column to the left edge while the rest scrolls under it.
   *
   * On a wide table, scrolling right and no longer knowing whose row you are on
   * is how the wrong record gets edited.
   */
  pinned?: boolean;
  /**
   * Hide while the table itself is under 768px. For a column that is context
   * rather than the point.
   *
   * A **container** query, not `md:`. A viewport breakpoint asks the window how
   * wide the browser is, which in a console full of panes is never the question:
   * between 768 and about 1400 every column showed regardless of how narrow its
   * card was, which is what clipped the action column off a table in a two-up
   * grid and lost two columns from `/chatbots` at 1280. The table declares
   * `@container/page` on its own root, so this asks the only box that knows.
   */
  secondary?: boolean;
  /**
   * Render this cell as `<th scope="row">` rather than `<td>`.
   *
   * The cell that *names* the row. A screen reader then announces it before
   * each of that row's values — "Crawl · Credits · 4" instead of a bare "4" —
   * which is the only reason two surfaces under `/billing` hand-built their own
   * tables rather than use this one. At most one per table.
   */
  rowHeader?: boolean;
  /**
   * Let the cell wrap onto several lines. Off by default.
   *
   * Cells are one line so the table can be *wider than its container* and
   * scroll. With wrapping on — which is what auto layout does by default — a
   * 12-column table satisfies `width: 100%` by wrapping every cell to two to
   * four lines instead: ragged row heights, `align-middle` centring short cells
   * against tall ones, no horizontal scrollbar, and every `pinned` column inert
   * because nothing ever scrolls sideways for it to pin against.
   */
  wrap?: boolean;
  /**
   * Ellipsise at the column's width instead of pushing the table wider.
   *
   * Defaults on when the column declares a `width`; meaningless without one.
   */
  truncate?: boolean;
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
  /**
   * The empty state's copy, as an `EmptyState`.
   *
   * Whatever is passed is rendered at **`size="inline"`**, whether the caller
   * said so or not: a table with no rows is a row that says why, not a poster.
   * `EmptyState`'s own default is `page` — a 340px centred block around a 48px
   * disc — so a table given a plain `<EmptyState title=… />` rendered a full
   * hero inside its own body, which is exactly what happened to the knowledge
   * gaps table. `size` is cloned onto the element rather than documented as a
   * rule call sites have to remember.
   */
  empty?: ReactNode;
  /**
   * The fourth state: this table's data is not this seat's to see.
   *
   * Without it a table shipped three of the four states DESIGN.md §5 requires,
   * and a feature-level wrapper had to be written specifically to add the
   * fourth — a feature reintroducing a system responsibility.
   */
  forbidden?: { title: string; description: string; action?: ReactNode } | null;

  /**
   * Let the table shrink to its container instead of scrolling wider than it.
   *
   * The default is right for a wide table: `min-w-max` plus an `overflow-auto`
   * wrapper keeps every cell on one line and scrolls sideways, which is what
   * makes a pinned column mean anything. It is wrong for a table in a narrow
   * column — Home's chatbot table in a two-up grid lost its action column at the
   * card's right edge, with the scroll affordance a 6-pixel bar under 44px rows
   * that nobody finds. A four-column table in a 26rem column does not want to be
   * scrolled; it wants to be narrower.
   *
   * `fit` switches the table to `table-fixed` and ellipsises every cell that has
   * not opted into `wrap`. Columns share the width equally unless they declare
   * one, so a `fit` table normally wants `width` on the columns that need it —
   * the action column, the status column — and nothing on the one that gives.
   */
  fit?: boolean;

  /**
   * Drop the table's own card, for a table seated inside one.
   *
   * `<Card><CardHeader/><DataTable/></Card>` is the console's most common table
   * idiom and, until this prop existed, it painted a `rounded-lg` bordered
   * surface flush inside another one: a doubled hairline down both sides and
   * two 10px radii a pixel apart at all four corners — the "broken corner" this
   * rebuild is largely about. It defaults to `false` only so that the ~20
   * standalone tables keep their surface; every table inside a `Card` should
   * pass it, alongside `CardBody flush`.
   */
  seated?: boolean;

  /** Opens the row's detail. Adds a real control, never a role on the `tr`. */
  onRowClick?: (row: T) => void;

  /**
   * Sorting. Omit both to let the table own its own sort state; supply both to
   * control it (a server-sorted table, or a sort shared with the URL).
   */
  sort?: SortState | null;
  onSortChange?: (sort: SortState | null) => void;
  defaultSort?: SortState | null;

  /** Enables the selection column. Omit for a read-only table. */
  selectedKeys?: ReadonlySet<string>;
  onSelectionChange?: (keys: Set<string>) => void;
  /** Shown above the table once anything is selected. */
  bulkActions?: ReactNode;
  /**
   * A human name for a row, for the selection checkbox's accessible label.
   * Without it the checkbox announces an opaque id.
   */
  rowLabel?: (row: T) => string;

  /**
   * Rows per page.
   *
   * On its own this is client-side paging: the table holds the page number and
   * slices `rows` itself. Add `page`, `onPageChange` and `rowCount` and it
   * becomes server paging — `rows` is taken to be exactly the page the server
   * returned, and the pager reports the server's total.
   */
  pageSize?: number;
  /**
   * The current page, 1-based. Supplying it (with `onPageChange`) switches the
   * table to server paging.
   *
   * Server paging exists because the alternative is a client-side pager over
   * whatever one request happened to return, which quietly reports "1–50 of 50"
   * for a workspace with nine thousand rows. Every server-paged surface in this
   * app was hand-rolling its own pager beside the table before this.
   */
  page?: number;
  onPageChange?: (page: number) => void;
  /** The server's total across all pages. Required for server paging. */
  rowCount?: number;
  /**
   * What one row *is*, for the count in the footer: "24 invoices", never
   * "24 rows". The plural adds an `s` unless `rowNounPlural` says otherwise.
   */
  rowNoun?: string;
  rowNounPlural?: string;
  /**
   * Prints the row count under the table. On by default (DESIGN.md rule 8).
   *
   * Turn it off only for a table whose length is a **fixed fact of the schema**
   * rather than a measurement of the data — a six-row reference of what each
   * webhook event means, a four-row key for a status column. "6 rows" under a
   * table that can never have a seventh is a number the reader has to read and
   * then discard. Anything a query returned keeps its count: that is the number
   * that tells "12 sources" from "12 of 400".
   *
   * A pager, when there is one, always states the count — it is the sentence
   * that makes the pager mean anything — so this only governs the bare form.
   */
  countSummary?: boolean;
  /**
   * A real `<tfoot>` — a totals row, aligned with the columns it totals.
   *
   * The caller supplies the `<tr>`s. Two surfaces under `/billing` hand-built
   * entire tables for want of this, at two more cell geometries.
   */
  footer?: ReactNode;
  /**
   * Bounds the scrolling body. Without one the table grows to its content and
   * the header can only stick once the body is long enough to be capped
   * automatically — see the note on `stickyHeader`.
   */
  maxHeight?: string;
  /**
   * Sticks the column heads to the top of the scrolling body. On by default.
   *
   * It used to be tied to `maxHeight`, which is passed at **zero** of the app's
   * 40 call sites, so no table in the console has ever had a sticky head and
   * every one of them lost its column names after eight rows.
   *
   * The head sticks to the table's own scrolling body, which is the only thing
   * it *can* stick to: the wrapper has to scroll X for a wide table, and
   * `overflow-x: auto` forces `overflow-y` to `auto` as well, so the wrapper is
   * a scroll container in both axes and an element sticks to its nearest
   * scrolling ancestor. A table can therefore never stick its head to the
   * *page*. The body is bounded automatically past `AUTO_BOUND_ROWS`, which is
   * the point at which losing the column names actually costs the reader
   * something; under that the page scrolls as one piece, which is right.
   */
  stickyHeader?: boolean;
  /**
   * @deprecated Ignored, and it never worked.
   *
   * It set `top` on the `thead` — but the head sticks inside the table's own
   * scroller, whose top edge is the card's top edge, so the only correct value
   * is 0. A non-zero one rendered as an empty band at the top of the card *and*
   * a header overlapping the first row: on Leads, a 52px band with the `thead`
   * at y=454 over a first row at y=446.
   *
   * The offset it was reaching for — clearing a sticky toolbar above the table —
   * is not the table's problem: that toolbar is outside the table's scroller and
   * never overlaps it. Delete the prop at the call site.
   */
  stickyOffset?: string;
  className?: string;
}

/**
 * How many rows the table will render before it caps its own height.
 *
 * Under it, nothing scrolls inside the card and the page scrolls as one piece,
 * which is what a short table should do. Over it, the body scrolls and the head
 * stays — the point at which losing the column names actually costs the reader
 * something.
 */
const AUTO_BOUND_ROWS = 12;
const AUTO_BOUND_HEIGHT = 'min(68dvh, 44rem)';

/** Everything that is genuinely a control, for the row-activation guard below. */
const INTERACTIVE = 'a[href],button,input,select,textarea,label,[role="button"],[role="link"],[role="menuitem"],[role="checkbox"],[contenteditable="true"]';

function SortIcon({ state }: { state: SortDirection | null }) {
  if (state === 'asc') return <ArrowUp aria-hidden className="h-3 w-3 shrink-0 text-text-primary" />;
  if (state === 'desc') return <ArrowDown aria-hidden className="h-3 w-3 shrink-0 text-text-primary" />;
  // Persistently visible, faintly. It used to be `opacity-0` until hover, so an
  // unsorted sortable column looked exactly like an unsortable one — a reader
  // had to hover all twelve to find out which sort, and a keyboard user tabbing
  // to the header saw nothing at all, because `group-hover` never fires on focus.
  return (
    <ChevronsUpDown
      aria-hidden
      className="h-3 w-3 shrink-0 text-text-tertiary opacity-50 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
    />
  );
}

const ALIGN_CLASS = { left: 'text-left', center: 'text-center', right: 'text-right' } as const;

/**
 * The console's table.
 *
 * Structural decisions, each replacing something a previous table got wrong:
 *
 * 1. **A row is never given `role="button"`.** Doing so replaces the row's
 *    implicit `role="row"`, which drops it out of the table's accessibility
 *    tree entirely — no row/column position, no header association, no "row 3
 *    of 40". Activation is a real control inside the first cell; the pointer
 *    path is a click handler on the row that ignores anything originating in
 *    another control. It used to be a pseudo-element stretched over the row,
 *    which is worse than it sounds: CSS paints positioned descendants *after*
 *    the inline content of non-positioned ones, so that overlay covered every
 *    later cell's contents — the "PDF" download in the invoice table was
 *    genuinely unclickable, and clicking it opened the drawer instead.
 * 2. **`border-separate`, with hairlines painted as inset shadows.** In
 *    `border-collapse` mode the table paints cell borders rather than the
 *    cells, so a stuck header or a pinned column arrives with none of its own
 *    and the rest of the row shows through underneath it.
 * 3. **One line per cell, and the table may be wider than its box.** Auto
 *    layout plus `w-full` means a wide table wraps rather than scrolls, which
 *    also makes every pinned column inert. `Column.wrap` opts a genuinely
 *    prose column back in.
 * 4. **Sorting lives here.** The old table had no sort API at all, so every
 *    consumer shipped an unsortable list while a fully sorted implementation
 *    sat unused in a dead directory. A server-paged table does not *offer* a
 *    client sort it would then refuse to perform.
 * 5. **All four states are the table's job**, plus the row count DESIGN.md
 *    rule 8 requires — which lives in a footer that is always there, not inside
 *    a pager that appears only past one page.
 * 6. **Geometry comes from the density triplet** (`--row-h`, `--cell-x`,
 *    `--cell-y`), so `Page density="dense"` re-spaces every table in the app
 *    without a component re-deciding a value, and a table's left edge matches
 *    the card padding above it.
 *
 * Not virtualized. It renders every row it is given, which is correct up to a
 * few hundred; a surface that can exceed that (conversations, a large lead
 * book) must page on the server rather than hand the whole set to this.
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
  forbidden = null,
  fit = false,
  seated = false,
  onRowClick,
  sort: controlledSort,
  onSortChange,
  defaultSort = null,
  selectedKeys,
  onSelectionChange,
  bulkActions,
  rowLabel,
  pageSize,
  page: controlledPage,
  onPageChange,
  rowCount,
  rowNoun = 'row',
  rowNounPlural,
  countSummary = true,
  footer,
  maxHeight,
  stickyHeader = true,
  // Accepted and ignored. See the prop's own note.
  stickyOffset: _stickyOffset,
  className,
}: DataTableProps<T>) {
  const [uncontrolledPage, setUncontrolledPage] = useState(0);
  const [uncontrolledSort, setUncontrolledSort] = useState<SortState | null>(defaultSort);

  // Controlled when the caller passes a handler; otherwise the table owns it.
  // A column with a comparator but no `onSortChange` used to render a sort
  // affordance that did nothing.
  const isControlled = onSortChange !== undefined;
  const sort = isControlled ? (controlledSort ?? null) : uncontrolledSort;
  const setSort = isControlled ? onSortChange : setUncontrolledSort;

  const selectable = Boolean(selectedKeys && onSelectionChange);
  const serverPaged = controlledPage !== undefined && onPageChange !== undefined;
  // A server-paged table that does not control its sort cannot sort at all, so
  // it must not offer the affordance: the arrow used to flip and nothing moved.
  const sortingOffered = !(serverPaged && !isControlled);

  const sortedRows = useMemo(() => {
    if (!sort) return rows;
    // Sorting one page of a server-paged set client-side would order fifty rows
    // out of nine thousand and present the result as the sort the user asked
    // for. A server-paged table sorts on the server or not at all.
    if (serverPaged && !isControlled) return rows;
    const column = columns.find((candidate) => candidate.key === sort.key);
    // `sortable: true` means the server ordered these; re-sorting here would
    // fight it.
    if (typeof column?.sortable !== 'function') return rows;
    const comparator = column.sortable;
    // Negating the comparator rather than reversing the array: `.reverse()`
    // also flips the order of tied rows, so a descending sort is not the mirror
    // of the ascending one and rows appear to shuffle.
    return [...rows].sort(
      sort.direction === 'desc' ? (a, b) => -comparator(a, b) : comparator,
    );
  }, [rows, sort, columns, serverPaged, isControlled]);

  const totalRows = serverPaged ? (rowCount ?? sortedRows.length) : sortedRows.length;
  const pageCount = pageSize ? Math.max(1, Math.ceil(totalRows / pageSize)) : 1;
  const safePage = serverPaged
    ? Math.min(Math.max(0, (controlledPage ?? 1) - 1), pageCount - 1)
    : Math.min(uncontrolledPage, pageCount - 1);

  function goToPage(next: number) {
    const clamped = Math.min(Math.max(0, next), pageCount - 1);
    if (serverPaged) onPageChange?.(clamped + 1);
    else setUncontrolledPage(clamped);
  }

  // A filter that shrinks the set must not strand the reader on a page that no
  // longer exists — and clearing the filter must not restore a page they never
  // asked to be on.
  //
  // Adjusted during render rather than in an effect. An effect would paint the
  // stale page first and then correct it, which flashes the wrong rows; this is
  // React's documented pattern for state that derives from changing props.
  //
  // Only for client paging. When the server owns the page, so does the caller:
  // resetting here would fight the URL the caller is keeping the page in.
  const [resetOn, setResetOn] = useState<{ rows: unknown; sort: SortState | null }>({ rows, sort });
  if (!serverPaged && (resetOn.rows !== rows || resetOn.sort !== sort)) {
    setResetOn({ rows, sort });
    setUncontrolledPage(0);
  }

  const visibleRows =
    pageSize && !serverPaged
      ? sortedRows.slice(safePage * pageSize, safePage * pageSize + pageSize)
      : sortedRows;

  function toggleSort(key: string) {
    // asc → desc → unsorted. The third press has to exist: without it there is
    // no way back to the server's own ordering, which is usually the meaningful
    // one (most recent first).
    if (sort?.key !== key) setSort({ key, direction: 'asc' });
    else if (sort.direction === 'asc') setSort({ key, direction: 'desc' });
    else setSort(null);
  }

  function toggleRow(key: string) {
    if (!selectedKeys || !onSelectionChange) return;
    const next = new Set(selectedKeys);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    onSelectionChange(next);
  }

  const pageKeys = visibleRows.map(rowKey);
  const allOnPageSelected = pageKeys.length > 0 && pageKeys.every((key) => selectedKeys?.has(key));
  const someOnPageSelected = pageKeys.some((key) => selectedKeys?.has(key));
  const selectedCount = selectedKeys?.size ?? 0;

  function toggleAllOnPage() {
    if (!selectedKeys || !onSelectionChange) return;
    const next = new Set(selectedKeys);
    // Scoped to the visible page. A "select all" that silently reaches rows the
    // user cannot see is how a bulk delete goes wrong.
    pageKeys.forEach((key) => (allOnPageSelected ? next.delete(key) : next.add(key)));
    onSelectionChange(next);
  }

  // A click anywhere on the row opens it — except when it started inside
  // something that is itself a control. Without the guard the row's handler
  // fires on top of the action the user actually pressed, which is how a
  // download button opens a drawer instead of downloading.
  const activateRow = useCallback(
    (row: T) => (event: MouseEvent<HTMLTableRowElement>) => {
      if (!onRowClick) return;
      // A click that started inside a control belongs to that control — the
      // download in the last cell, a menu trigger, a checkbox, and the row's own
      // activator in cell 0, which calls this itself and must not do it twice.
      if ((event.target as HTMLElement | null)?.closest(INTERACTIVE)) return;
      onRowClick(row);
    },
    [onRowClick],
  );

  const colSpan = columns.length + (selectable ? 1 : 0);
  const state = loading
    ? 'loading'
    : error
      ? 'error'
      : forbidden
        ? 'forbidden'
        : visibleRows.length === 0
          ? 'empty'
          : 'rows';

  // `table-fixed` when every column has declared a width, or when the caller has
  // asked the table to fit its column — otherwise auto layout is the honest
  // model and `width` stays a suggestion.
  const fixedLayout = fit || (columns.length > 0 && columns.every((column) => column.width));
  const scrollMax =
    maxHeight ?? (stickyHeader && visibleRows.length > AUTO_BOUND_ROWS ? AUTO_BOUND_HEIGHT : undefined);

  // Where the body is, horizontally, written straight onto the DOM rather than
  // held in state: a pinned column needs its trailing edge only once content is
  // actually travelling underneath it, the right-hand fade only while there is
  // more to the right, and re-rendering forty rows on every scroll frame to
  // learn either is not worth it.
  //
  // `data-scroll-end` has to be correct before the first scroll event, or a
  // table that overflows on load shows no edge at all until it is touched —
  // which is exactly the table this fixes. `syncScroll` runs from the ref
  // callback on mount and from a `ResizeObserver` when the column changes width.
  const syncScroll = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;
    const scrolled = element.scrollLeft > 0;
    // 1px of slack: a fractional layout width leaves `scrollWidth` a hair above
    // `scrollLeft + clientWidth` at the true end and the fade never turns off.
    const atEnd = element.scrollLeft + element.clientWidth >= element.scrollWidth - 1;
    element.dataset.scrolled = scrolled ? 'true' : 'false';
    element.dataset.scrollEnd = atEnd ? 'true' : 'false';
  }, []);

  // React 19 runs the function a ref callback returns as its cleanup.
  const attachScroller = useCallback(
    (element: HTMLDivElement | null) => {
      syncScroll(element);
      if (!element || typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(() => syncScroll(element));
      observer.observe(element);
      return () => observer.disconnect();
    },
    [syncScroll],
  );

  const noun = totalRows === 1 ? rowNoun : (rowNounPlural ?? `${rowNoun}s`);
  const headCellClass =
    'h-[var(--row-h)] whitespace-nowrap bg-surface-sunken align-middle text-xs font-medium text-text-secondary';
  // The selection column is narrow and fixed, so the bulk-action bar can be laid
  // over the header *beside* it and the select-all checkbox stays reachable
  // while a selection is live.
  const selectCellClass = 'w-12 px-3';

  return (
    <div
      className={cn(
        // `@container/page`, so `Column.secondary` — and any `Grid` or
        // `PropertyGrid` rendered inside a cell — measures THIS TABLE. See the
        // note on `secondary`.
        'console-scroll-edge relative @container/page',
        !seated && 'overflow-hidden rounded-lg border border-border bg-surface',
        className,
      )}
    >
      <div
        ref={attachScroller}
        onScroll={(event) => syncScroll(event.currentTarget)}
        className="overflow-auto"
        style={scrollMax ? { maxHeight: scrollMax } : undefined}
      >
        <table
          className={cn('console-table text-left', fixedLayout ? 'w-full table-fixed' : 'w-full min-w-max')}
          aria-busy={loading || undefined}
        >
          <caption className="sr-only">{caption}</caption>
          {/* `top: 0` always — see `stickyOffset`. The head sticks inside the
              table's own scroller, whose top edge is the card's. */}
          <thead className={cn(stickyHeader && 'sticky top-0 z-[var(--z-sticky)]')}>
            <tr>
              {selectable ? (
                <th scope="col" className={cn(headCellClass, selectCellClass)}>
                  <Checkbox
                    checked={allOnPageSelected ? true : someOnPageSelected ? 'indeterminate' : false}
                    onCheckedChange={toggleAllOnPage}
                    aria-label={
                      allOnPageSelected
                        ? 'Clear selection on this page'
                        : 'Select all rows on this page'
                    }
                  />
                </th>
              ) : null}
              {columns.map((column) => {
                const isSorted = sort?.key === column.key;
                const direction = isSorted ? sort.direction : null;
                const align = column.align ?? (column.type === 'number' ? 'right' : 'left');
                const sortable = Boolean(column.sortable) && sortingOffered;
                return (
                  <th
                    key={column.key}
                    scope="col"
                    style={column.width ? { width: column.width } : undefined}
                    // `aria-sort` is what makes the sort state audible; the
                    // arrow glyph alone tells a screen-reader user nothing.
                    aria-sort={
                      isSorted ? (direction === 'asc' ? 'ascending' : 'descending') : undefined
                    }
                    className={cn(
                      headCellClass,
                      'px-[var(--cell-x)]',
                      ALIGN_CLASS[align],
                      column.pinned && 'is-pinned sticky left-0 z-[var(--z-sticky)]',
                      column.secondary && 'hidden @3xl/page:table-cell',
                    )}
                  >
                    {sortable ? (
                      <button
                        type="button"
                        onClick={() => toggleSort(column.key)}
                        className={cn(
                          'group inline-flex items-center gap-1 rounded-xs',
                          'transition-colors hover:text-text-primary',
                          align === 'right' && 'flex-row-reverse',
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
            {state === 'loading' ? (
              // `aria-hidden` on the placeholder rows: the table already reports
              // `aria-busy`, and a screen reader walking six nameless rows
              // learns nothing. The count follows the page size and the row
              // height follows the real one, so the body neither jumps nor
              // resizes when the data lands.
              Array.from({ length: Math.min(pageSize ?? 8, AUTO_BOUND_ROWS) }, (_, index) => (
                <tr key={`skeleton-${index}`} aria-hidden>
                  {selectable ? (
                    <td className={cn('h-[var(--row-h)] py-[var(--cell-y)]', selectCellClass)}>
                      <Skeleton className="h-4 w-4" />
                    </td>
                  ) : null}
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      className={cn(
                        'h-[var(--row-h)] px-[var(--cell-x)] py-[var(--cell-y)]',
                        column.secondary && 'hidden @3xl/page:table-cell',
                      )}
                    >
                      <Skeleton className="h-3 w-full max-w-40" />
                    </td>
                  ))}
                </tr>
              ))
            ) : state === 'error' ? (
              <tr>
                {/* The cell carries no row hairline: it is a state, not a row,
                    and the inset shadow would double the container's own edge.
                    `px-[var(--cell-x)]` is written here rather than left to the
                    state's own gutter: `flush` on the state below drops that
                    gutter on the assumption the cell supplies one, and this
                    cell — unlike an ordinary data cell — carried none, so the
                    state's copy sat flush against the table's own edge. */}
                <td colSpan={colSpan} className="px-[var(--cell-x)]" style={{ boxShadow: 'none' }}>
                  <ErrorState flush size="inline" description={error ?? undefined} onRetry={onRetry} />
                </td>
              </tr>
            ) : state === 'forbidden' && forbidden ? (
              <tr>
                <td colSpan={colSpan} className="px-[var(--cell-x)]" style={{ boxShadow: 'none' }}>
                  <LockedState
                    flush
                    size="inline"
                    title={forbidden.title}
                    description={forbidden.description}
                    action={forbidden.action}
                  />
                </td>
              </tr>
            ) : state === 'empty' ? (
              <tr>
                <td colSpan={colSpan} className="px-[var(--cell-x)]" style={{ boxShadow: 'none' }}>
                  {isValidElement<{ size?: string; flush?: boolean }>(empty) ? (
                    // `flush` on the cloned state assumes this cell supplies
                    // the horizontal gutter, so the cell has to actually carry
                    // `px-[var(--cell-x)]` — an ordinary data `<td>` does, this
                    // one did not, and the state's copy sat flush against the
                    // table's own edge as a result.
                    cloneElement(empty, { size: 'inline', flush: true })
                  ) : (
                    empty ?? (
                      <EmptyState
                        flush
                        size="inline"
                        title="Nothing to show"
                        description="No rows matched."
                      />
                    )
                  )}
                </td>
              </tr>
            ) : (
              visibleRows.map((row) => {
                const key = rowKey(row);
                const selected = selectedKeys?.has(key) ?? false;
                return (
                  <tr
                    key={key}
                    // One source for the row's ground: the sticky cells below
                    // read it back off the row rather than restating the same
                    // pair of colours a third and fourth time.
                    data-selected={selected || undefined}
                    onClick={onRowClick ? activateRow(row) : undefined}
                    className={cn(
                      'group transition-colors duration-[var(--dur-fast)]',
                      selected ? 'bg-accent-50' : 'hover:bg-surface-hover',
                      onRowClick && 'cursor-pointer',
                    )}
                  >
                    {selectable ? (
                      <td
                        className={cn(
                          'h-[var(--row-h)] py-[var(--cell-y)] align-middle',
                          selectCellClass,
                          'bg-surface group-hover:bg-surface-hover group-data-[selected]:bg-accent-50',
                        )}
                      >
                        <Checkbox
                          checked={selected}
                          onCheckedChange={() => toggleRow(key)}
                          aria-label={`Select ${rowLabel ? rowLabel(row) : key}`}
                        />
                      </td>
                    ) : null}
                    {columns.map((column, columnIndex) => {
                      const content = column.render(row);
                      const activates = onRowClick && columnIndex === 0;
                      const align = column.align ?? (column.type === 'number' ? 'right' : 'left');
                      const figure =
                        column.type === 'number' ||
                        column.type === 'id' ||
                        (column.type === undefined && column.align === 'right');
                      const Cell = column.rowHeader ? 'th' : 'td';
                      return (
                        <Cell
                          key={column.key}
                          scope={column.rowHeader ? 'row' : undefined}
                          className={cn(
                            'h-[var(--row-h)] px-[var(--cell-x)] py-[var(--cell-y)]',
                            'align-middle text-sm font-normal text-text-primary',
                            ALIGN_CLASS[align],
                            figure && 'figure',
                            column.wrap ? 'whitespace-normal' : 'whitespace-nowrap',
                            // Under `fit` there is nowhere for an over-long cell
                            // to go, so truncation is the default rather than
                            // something a `width` happens to switch on.
                            (column.truncate ?? (fit || Boolean(column.width))) &&
                              !column.wrap &&
                              'truncate',
                            // A pinned cell paints its own ground, so it needs
                            // the row's hover repeated on it — otherwise the
                            // pinned column stays white while the row lights up.
                            column.pinned &&
                              cn(
                                'is-pinned sticky left-0 z-1',
                                'bg-surface group-hover:bg-surface-hover group-data-[selected]:bg-accent-50',
                              ),
                            column.secondary && 'hidden @3xl/page:table-cell',
                          )}
                        >
                          {activates ? (
                            <button
                              type="button"
                              data-row-activator
                              onClick={() => onRowClick(row)}
                              className="max-w-full truncate rounded-xs text-left"
                            >
                              {content}
                            </button>
                          ) : (
                            content
                          )}
                        </Cell>
                      );
                    })}
                  </tr>
                );
              })
            )}
          </tbody>

          {footer && state === 'rows' ? (
            <tfoot
              className={cn(
                'bg-surface-sunken text-sm font-medium text-text-primary',
                '[&_td]:h-[var(--row-h)] [&_td]:px-[var(--cell-x)] [&_td]:py-[var(--cell-y)] [&_td]:align-middle',
                '[&_th]:h-[var(--row-h)] [&_th]:px-[var(--cell-x)] [&_th]:py-[var(--cell-y)] [&_th]:text-left [&_th]:align-middle',
              )}
            >
              {footer}
            </tfoot>
          ) : null}
        </table>
      </div>

      {/* Painted over the header rather than pushed above it. Mounting a bar
          above the `thead` moved the entire body down by its height at the exact
          moment the pointer was on a checkbox, so the next click landed on the
          wrong row. Same height as the header row, so nothing moves at all. */}
      {selectable && selectedCount > 0 ? (
        <div className="absolute left-12 right-0 top-0 z-[var(--z-sticky)] flex h-[var(--row-h)] items-center gap-3 border-b border-border bg-accent-50 pl-1 pr-[var(--cell-x)]">
          <p className="shrink-0 text-sm font-medium text-accent-700">
            <span className="figure">{selectedCount}</span> selected
          </p>
          <div className="flex min-w-0 flex-wrap items-center gap-2">{bulkActions}</div>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto shrink-0"
            onClick={() => onSelectionChange?.(new Set())}
          >
            Clear
          </Button>
        </div>
      ) : null}

      {/* The count is not part of the pager. It used to be, so a table with one
          page — six of the app's forty have no `pageSize` at all — printed no
          count anywhere, and the reader could not tell "12 sources" from "12 of
          400". DESIGN.md rule 8 asks for it on every table.

          No `border-t`: the last row's own inset hairline is already the rule
          above this bar, and drawing a second one is what made every table look
          bottom-heavy. */}
      {/* The row count DESIGN.md rule 8 asks of every table — which used to live
          inside the pager, so a table with one page (six of the app's forty pass
          no `pageSize` at all) reported its size nowhere and the reader could not
          tell "12 sources" from "12 of 400".

          No `border-t` on either form: the last row's own inset hairline is
          already the rule above this bar, and drawing a second one is what made
          every table in the console look bottom-heavy. */}
      {state === 'rows' ? (
        pageSize && totalRows > pageSize ? (
          <nav
            aria-label={`${caption} pages`}
            className="flex items-center justify-between gap-3 px-[var(--cell-x)] py-2"
          >
            <p className="text-xs text-text-secondary">
              <span className="figure">{safePage * pageSize + 1}</span>–
              <span className="figure">{Math.min((safePage + 1) * pageSize, totalRows)}</span> of{' '}
              <span className="figure">{totalRows}</span> {noun}
            </p>
            <div className="flex items-center gap-1">
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Previous page"
                disabled={safePage === 0}
                onClick={() => goToPage(safePage - 1)}
              >
                <ChevronLeft aria-hidden className="h-icon-md w-icon-md" />
              </Button>
              {/* One string for assistive tech: the three nodes below read as
                  "1 slash 12" on their own. */}
              <span
                className="px-1 text-xs text-text-secondary"
                aria-label={`Page ${safePage + 1} of ${pageCount}`}
              >
                <span aria-hidden className="figure">{safePage + 1}</span>
                <span aria-hidden> / </span>
                <span aria-hidden className="figure">{pageCount}</span>
              </span>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Next page"
                disabled={safePage >= pageCount - 1}
                onClick={() => goToPage(safePage + 1)}
              >
                <ChevronRight aria-hidden className="h-icon-md w-icon-md" />
              </Button>
            </div>
          </nav>
        ) : countSummary ? (
          <p className="px-[var(--cell-x)] py-2 text-xs text-text-secondary" aria-live="polite">
            <span className="figure">{totalRows}</span> {noun}
          </p>
        ) : null
      ) : null}
    </div>
  );
}
