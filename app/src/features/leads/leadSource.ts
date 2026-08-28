import { formatDuration } from '../../ui';
import { t as translateNow } from '../../i18n/i18n';

/**
 * Reading the loosely-typed attribution blob.
 *
 * `lead.source` is a free-form JSON column on plans that include attribution and
 * simply absent on the ones that do not, so every read of it goes through these
 * rather than through a cast the compiler cannot check.
 */

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function truncate(value: string, max = 80): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * The 0–20 engagement score as a band, not a second numeric scale.
 *
 * It already feeds the headline 0–100 quality score, and a second number in the
 * same panel competes with the verdict the panel exists to give.
 */
export function engagementBand(score: number): string {
  if (score >= 15) return translateNow('leads.high') || 'High';
  if (score >= 8) return translateNow('leads.medium') || 'Medium';
  return translateNow('leads.low') || 'Low';
}

export interface JourneyStep {
  path: string;
  timestamp: string | null;
  dwell: string | null;
  last: boolean;
}

/** Each page's dwell time is the gap to the next entry's timestamp. */
export function buildJourney(entries: readonly unknown[]): JourneyStep[] {
  return entries.map((raw, index) => {
    const entry = asRecord(raw);
    const next = asRecord(entries[index + 1]);
    const from = asText(entry.ts);
    const to = asText(next.ts);
    let dwell: string | null = null;
    if (from && to) {
      const start = Date.parse(from);
      const end = Date.parse(to);
      // A clock that ran backwards, or a gap of days, is not a dwell time.
      const seconds = (end - start) / 1000;
      if (Number.isFinite(seconds) && seconds >= 0 && seconds <= 86_400) {
        dwell = formatDuration(seconds);
      }
    }
    return {
      path: asText(entry.path) ?? '',
      timestamp: from,
      dwell,
      last: index === entries.length - 1,
    };
  });
}
