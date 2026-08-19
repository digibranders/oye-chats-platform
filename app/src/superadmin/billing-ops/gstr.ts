/**
 * The GSTR-1 export's period, and the file it produces.
 *
 * A filing period is not a date range picker: GSTR-1 is filed per **IST
 * calendar month**, the server validates `^\d{4}-\d{2}$` and refuses anything
 * else with a 422, and a CA who receives the wrong month files the wrong return.
 * So the month is chosen from a list of real months, spelled out in full, and
 * the chosen one is repeated on the download so it cannot be misread.
 */

/** What the server's `month` query parameter must look like. */
export const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isValidMonth(month: string): boolean {
  return MONTH_PATTERN.test(month);
}

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** `2026-07` → `July 2026`. Returns the input unchanged if it is not a month. */
export function monthLabel(month: string): string {
  if (!isValidMonth(month)) return month;
  const [year, index] = month.split('-');
  return `${MONTH_NAMES[Number(index) - 1]} ${year}`;
}

/** `2026-07-19` → `2026-07`. */
export function toMonthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * The last `count` months, newest first, ending with the month `now` is in.
 *
 * The current month is included and marked, because a CA often pulls a
 * mid-month draft to reconcile against — but it is labelled "in progress" so
 * nobody files a partial month by accident.
 */
export function recentMonths(now: Date = new Date(), count = 18): string[] {
  const months: string[] = [];
  const cursor = new Date(now.getFullYear(), now.getMonth(), 1);
  for (let index = 0; index < count; index += 1) {
    months.push(toMonthKey(cursor));
    cursor.setMonth(cursor.getMonth() - 1);
  }
  return months;
}

/** The filename the server sets in `Content-Disposition`, mirrored client-side. */
export function gstrFilename(month: string): string {
  return `gstr-${month}.csv`;
}

/**
 * How many document rows a returned export actually contains.
 *
 * The response is one CSV with two parts: the document rows, a blank line, then
 * a `SUMMARY` block. A file with a header, no rows and a summary of zeroes is a
 * perfectly valid response for a month in which nothing was invoiced — and it
 * is also what a broken query returns, so the console counts the rows and says
 * which one the operator just downloaded instead of letting the browser drop a
 * silent empty file into their downloads folder.
 *
 * The server prefixes a UTF-8 BOM so Excel reads non-ASCII legal names
 * correctly; it is stripped here before counting.
 */
export function gstrRowCount(csv: string): number {
  const body = csv.replace(/^\uFEFF/, '');
  const lines = body.split(/\r?\n/);
  let count = 0;
  // Skip the header, stop at the blank line that precedes the SUMMARY block.
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '') break;
    count += 1;
  }
  return count;
}
