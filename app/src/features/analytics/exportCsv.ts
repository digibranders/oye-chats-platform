import { csvField } from '../../lib/csvSafe';
import { downloadCsv } from '../../lib/downloadCsv';

/**
 * Export, on every panel that holds a table.
 *
 * Feedback was the only analytics surface in the product with a download, so
 * every other number on the page could be read but not taken anywhere — and the
 * first thing an agency does with a client's figures is put them in a
 * spreadsheet. One helper rather than one per panel: cells go through
 * `csvField`, which is the injection defence, so a panel added later is safe
 * without anyone remembering to be.
 */

export type CsvValue = string | number | null | undefined;

/** A filename that says what is in the file and which window it covers. */
export function csvFilename(panel: string, window: string): string {
  const slug = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  return `oyechats-${slug(panel)}-${slug(window)}.csv`;
}

export function exportRows(
  filename: string,
  headers: readonly string[],
  rows: ReadonlyArray<readonly CsvValue[]>,
): void {
  const lines = [
    headers.map(csvField).join(','),
    ...rows.map((row) => row.map(csvField).join(',')),
  ];
  downloadCsv(lines.join('\r\n'), filename);
}
