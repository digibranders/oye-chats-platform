import type { LogEntry, LogsResponse } from './types';

/**
 * The log reader's rules.
 *
 * Two things about this surface are not cosmetic.
 *
 * **The service is allow-listed, not typed.** `logs_service.ALLOWED_SERVICES` is
 * `{"oyechats-api", "oyechats-worker"}` and it is the check that keeps a
 * user-controlled string out of a `journalctl` argument list. A free-text box
 * here would be a screen inviting people to try values the server exists to
 * refuse, so the console offers exactly those two and nothing else.
 *
 * **It is bounded, and it does not follow.** `lines` is clamped to 10–5,000
 * server-side. There is no streaming endpoint, and a UI that polled one into an
 * auto-scrolling pane would be a live feed of customer conversations nobody
 * asked to keep on screen. Fetching is an explicit act.
 */

export const LOG_SERVICES = [
  { value: 'oyechats-api', label: 'API (oyechats-api.service)' },
  { value: 'oyechats-worker', label: 'Worker (oyechats-worker.service)' },
] as const;

export type LogService = (typeof LOG_SERVICES)[number]['value'];

export const LOG_LEVELS = [
  { value: '', label: 'Any level' },
  { value: 'debug', label: 'Debug' },
  { value: 'info', label: 'Info' },
  { value: 'warning', label: 'Warning' },
  { value: 'error', label: 'Error' },
  { value: 'critical', label: 'Critical' },
] as const;

export const LOG_LINE_CHOICES = ['100', '250', '500', '1000', '2500', '5000'] as const;

export const MAX_GREP_LENGTH = 200;

/** Only the two allow-listed units are ever requested. */
export function isAllowedService(value: string): value is LogService {
  return LOG_SERVICES.some((service) => service.value === value);
}

export function coerceService(value: string): LogService {
  return isAllowedService(value) ? value : 'oyechats-api';
}

/** Clamped exactly as `fetch_logs` clamps it, so the control cannot ask for more. */
export function coerceLines(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 500;
  return Math.max(10, Math.min(Math.trunc(parsed), 5000));
}

export function coerceLevel(value: string): string {
  return LOG_LEVELS.some((level) => level.value === value && level.value !== '') ? value : '';
}

/** The grep term the endpoint will accept: trimmed and within its length bound. */
export function coerceGrep(value: string): string {
  return value.trim().slice(0, MAX_GREP_LENGTH);
}

export const LEVEL_TONE: Record<string, 'danger' | 'warning' | 'neutral'> = {
  critical: 'danger',
  error: 'danger',
  warning: 'warning',
  info: 'neutral',
  debug: 'neutral',
};

/**
 * The whole page, as one block of text to paste into a ticket.
 *
 * This is the actual job of the screen: a super-admin reading logs here is
 * almost always about to quote them somewhere else. Rebuilding the lines by hand
 * from a rendered table is how half a stack trace ends up in a support reply.
 */
export function logsAsText(response: LogsResponse | null): string {
  if (!response) return '';
  const header = `# ${response.service}.service — ${response.entries.length} lines${response.available ? '' : ' (journalctl unavailable on this host)'}`;
  return [header, ...response.entries.map(formatEntry)].join('\n');
}

export function formatEntry(entry: LogEntry): string {
  const stamp = entry.timestamp ?? '—';
  const pid = entry.pid == null ? '' : `[${entry.pid}] `;
  return `${stamp} ${entry.level.toUpperCase().padEnd(8)} ${pid}${entry.message}`;
}

/** Counts per level, for the summary line above the log body. */
export function levelCounts(entries: readonly LogEntry[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) counts[entry.level] = (counts[entry.level] ?? 0) + 1;
  return counts;
}

/**
 * The query for `GET /superadmin/logs`, with every value already bounded.
 *
 * A plain object rather than an encoded string: the platform client cleans and
 * serialises params itself, and a screen hand-encoding its own query string is
 * one that will eventually forget to encode something.
 */
export function logsParams(params: {
  service: string;
  lines: string;
  level: string;
  grep: string;
}): Record<string, string | number> {
  const query: Record<string, string | number> = {
    service: coerceService(params.service),
    lines: coerceLines(params.lines),
  };
  const level = coerceLevel(params.level);
  if (level) query.level = level;
  const grep = coerceGrep(params.grep);
  if (grep) query.grep = grep;
  return query;
}
