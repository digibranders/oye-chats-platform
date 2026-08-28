import { type ReactNode } from 'react';
import { cn } from '../lib/cn';

export interface ChartDataColumn {
  key: string;
  header: string;
  /** Right-aligns and sets the column as a figure. */
  numeric?: boolean;
}

export interface ChartDataTableProps {
  /** Names the table. It is the chart's text equivalent, so it says which chart. */
  caption: string;
  columns: readonly ChartDataColumn[];
  /** One record per row, keyed by column key. Pre-formatted values. */
  rows: readonly Record<string, ReactNode>[];
  /** Identity per row, when the first column is not unique. */
  rowKey?: (row: Record<string, ReactNode>, index: number) => string;
  className?: string;
}

/**
 * The chart, as a table — the body of every "View as table" disclosure.
 *
 * A chart is a picture, and `ChartFrame` already carries a one-sentence summary
 * for anyone who cannot see it. This is the rest: the actual numbers, which is
 * what a person exporting a report, reading with a screen reader, or printing
 * the page needs. Two features had written the same `<table>` with the same head
 * styling and left their numeric cells left-aligned — which defeats the point of
 * tabular figures, since the digits no longer line up in a column.
 *
 * Deliberately not `DataTable`: no sort, no paging, no selection, no row count,
 * no card. It is a text equivalent of a picture, and every one of those
 * affordances would be chrome around a dozen numbers.
 */
export function ChartDataTable({ caption, columns, rows, rowKey, className }: ChartDataTableProps) {
  return (
    <table className={cn('console-table w-full text-left', className)}>
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr>
          {columns.map((column) => (
            <th
              key={column.key}
              scope="col"
              className={cn(
                'whitespace-nowrap py-1.5 pr-4 text-xs font-medium text-text-secondary last:pr-0',
                column.numeric && 'text-right',
              )}
            >
              {column.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={rowKey ? rowKey(row, index) : String(row[columns[0].key] ?? index)}>
            {columns.map((column) => (
              <td
                key={column.key}
                className={cn(
                  'py-1.5 pr-4 text-sm text-text-primary last:pr-0',
                  column.numeric && 'figure text-right',
                )}
              >
                {row[column.key]}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
