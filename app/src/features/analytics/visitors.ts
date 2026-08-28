
import { t as translateNow } from '../../i18n/i18n';/**
 * Visitors — a deduped view of the people who talked to the chatbots.
 *
 * `GET /analytics/visitors` has always returned this and the product has never
 * shown it: `getVisitorsData` sits in the API client with no caller. The
 * endpoint groups sessions by visitor, so one row is one person, not one chat,
 * and it carries every session id that person owns.
 *
 * It takes no time filter — only `limit`/`offset` and the plan's own history
 * retention — so the page's range is applied here, to `last_active_at`. That is
 * the same range every other panel uses, which is the point: a workspace that
 * had 40 conversations last month should not read 40 in one card and 300 in the
 * one beside it.
 */

export interface VisitorRow {
  /** Every session this visitor owns, comma-joined. Unique, and the row key. */
  id: string;
  /** The anonymised handle the API assigns, e.g. `user3`. */
  visitor: string;
  location: string;
  device: string;
  /** Messages exchanged across all of this visitor's sessions. */
  messages: number;
  /** How many separate conversations they had. */
  conversations: number;
  /** ISO timestamp, or `null` when the API did not report one. */
  lastActiveAt: string | null;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function parseVisitors(
  raw: ReadonlyArray<Record<string, unknown>> | null | undefined,
): VisitorRow[] {
  const rows: VisitorRow[] = [];
  for (const record of raw ?? []) {
    const id = readString(record, 'session_id');
    if (!id) continue;
    const sessions = Array.isArray(record.all_session_ids) ? record.all_session_ids.length : 1;
    rows.push({
      id,
      visitor: readString(record, 'visitor') ?? (translateNow('analytics.unknownVisitor') || 'Unknown visitor'),
      location: readString(record, 'location') ?? (translateNow('analytics.unknown') || 'Unknown'),
      device: readString(record, 'device') ?? (translateNow('analytics.unknown') || 'Unknown'),
      messages: readNumber(record, 'chats'),
      conversations: sessions,
      lastActiveAt: readString(record, 'last_active_at'),
    });
  }
  return rows;
}

/**
 * Keep the visitors last seen inside the window.
 *
 * A row with no timestamp survives only on "All time": it cannot be placed in a
 * window, and silently counting it inside one would overstate every period.
 */
export function filterVisitorsToWindow(
  rows: readonly VisitorRow[],
  since: Date | null,
): VisitorRow[] {
  if (since === null) return [...rows];
  const cutoff = since.getTime();
  return rows.filter((row) => {
    if (!row.lastActiveAt) return false;
    const seen = new Date(row.lastActiveAt).getTime();
    return Number.isFinite(seen) && seen >= cutoff;
  });
}
