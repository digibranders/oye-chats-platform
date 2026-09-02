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

export interface Journey {
  steps: JourneyStep[];
  /**
   * True when at least one entry stated a `phase`, so {@link Journey.steps} is
   * the pre-chat leg and can be labelled as such. False when the whole array
   * arrived unphased, which is the only case where "before the chat" is a guess
   * rather than a fact, and the caller has to say something weaker.
   */
  phased: boolean;
}

/**
 * The pre-chat leg of a visitor's journey.
 *
 * `lead.source.journey` spans the **whole** visit: the backend writes entries
 * with `phase` of `pre`, `chat` or `post` (see
 * `api/app/services/journey_analytics_service.py`, which filters on exactly
 * that field). Taking the array whole and calling it "pages before the chat"
 * counted the post-chat browsing too, so a visitor who read 3 pages, chatted,
 * then read 6 more rendered "9 pages before the chat" with "the chat opened on
 * the last" pointing at a page they reached afterwards.
 *
 * Entries with a phase are filtered to `pre`. An array where nothing carries a
 * phase is left whole and reported as unphased, because dropping every entry
 * would blank the panel for older leads captured before the field existed.
 *
 * Each page's dwell time is the gap to the next kept entry's timestamp.
 */
export function buildJourney(entries: readonly unknown[]): Journey {
  const phased = entries.some((raw) => asText(asRecord(raw).phase) !== null);
  const kept = phased
    ? entries.filter((raw) => asText(asRecord(raw).phase) === 'pre')
    : [...entries];

  const steps = kept.map((raw, index) => {
    const entry = asRecord(raw);
    const next = asRecord(kept[index + 1]);
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
      last: index === kept.length - 1,
    };
  });

  return { steps, phased };
}
