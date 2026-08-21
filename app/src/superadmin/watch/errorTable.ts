/**
 * Turning the errors endpoint's opaque rows into columns.
 *
 * `/superadmin/errors` is the one list in this console with no schema: it is a
 * Sentry issue summary, and the API returns whatever Sentry gave it. The screen
 * used to render `JSON.stringify(items, null, 2)` in a `CodeBlock`, which on a
 * twelve-issue payload is 1,800px of pretty-printed JSON on the first screen of
 * the console — three screenfuls to read what a twelve-row table says in one.
 *
 * So the columns are derived from the payload instead of guessed: whatever keys
 * the rows actually carry become the columns, in a stable order, and nothing is
 * invented. A field the endpoint does not send simply has no column.
 */

/**
 * The keys worth putting first, when they are present.
 *
 * Sentry's issue summary leads with the level and the message; everything after
 * that is context. Any key not named here keeps the order it first appeared in,
 * so a payload this list has never seen still reads left to right in the order
 * the server wrote it.
 */
const LEADING = ['level', 'title', 'message', 'culprit', 'count', 'users', 'last_seen', 'lastSeen'];

/** Keys that carry no information for a reader — ids Sentry needs and we do not. */
const HIDDEN = new Set(['id', 'issue_id', 'project_id', 'shortId', 'short_id']);

/** Every column the payload justifies, ordered. */
export function errorFieldKeys(rows: readonly Record<string, unknown>[]): string[] {
  const seen: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (HIDDEN.has(key)) continue;
      if (!seen.includes(key)) seen.push(key);
    }
  }
  const rank = (key: string): number => {
    const index = LEADING.indexOf(key);
    return index === -1 ? LEADING.length + seen.indexOf(key) : index;
  };
  return seen.sort((a, b) => rank(a) - rank(b));
}

/** `last_seen` → `Last seen`. The server's own name, made readable. */
export function errorFieldLabel(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** An ISO-8601 instant, which the table renders as a date rather than a string. */
export function isIsoInstant(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value);
}

/**
 * One cell, as text.
 *
 * Returns `null` for an absent value so the table prints its own em dash rather
 * than the string "null", and compacts anything structured to JSON — a nested
 * object in a cell is still better read than the whole payload was.
 */
export function errorCellText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') return value === '' ? null : value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

/** A Sentry level, as one of the system's tones. */
export function errorLevelTone(value: unknown): 'danger' | 'warning' | 'neutral' {
  const level = typeof value === 'string' ? value.toLowerCase() : '';
  if (level === 'fatal' || level === 'critical' || level === 'error') return 'danger';
  if (level === 'warning' || level === 'warn') return 'warning';
  return 'neutral';
}
