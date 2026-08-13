/**
 * Browser download for a client-built CSV.
 *
 * Shared rather than per-feature because getting a CSV to open correctly is
 * three non-obvious details, and every export needs all three. A copy that
 * misses one fails quietly — in a spreadsheet on someone else's machine, which
 * is the worst place to discover it. Pairs with `csvSafe` in `./csvSafe`:
 * that one decides what goes in the file, this one decides how it leaves.
 */

/**
 * UTF-8 byte order mark.
 *
 * Written as an escape, not as the literal character: the literal is invisible
 * in an editor, so a copy of this line looks identical whether or not it still
 * has the BOM in it.
 */
const UTF8_BOM = '\ufeff';

/**
 * Trigger a browser download of `content` as a UTF-8 CSV named `filename`.
 *
 * Three things this gets right that a hand-rolled Blob download usually does
 * not:
 *
 * 1. The BOM. Without it Excel decodes the file in the system codepage, so
 *    every Devanagari, Tamil or accented character in it renders as garbage —
 *    which on this product's market is most of a typical export.
 * 2. `charset=utf-8` on the MIME type, for the consumers that read it.
 * 3. Attaching the anchor to the document before clicking it. Firefox ignores
 *    a programmatic click on a detached element, so a download that works in
 *    Chrome silently does nothing there.
 */
export function downloadCsv(content: string, filename: string): void {
  const blob = new Blob([UTF8_BOM, content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
