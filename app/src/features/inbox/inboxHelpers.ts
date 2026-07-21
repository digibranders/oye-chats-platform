import { type StatusBadgeProps } from '../../design-system';

/**
 * Pure presentation helpers for the Inbox. No React, no side effects — kept
 * separate so the panels stay declarative and these stay unit-testable.
 */

/** The offline-message lifecycle, as stored by the backend. */
export type OfflineStatus = 'new' | 'read' | 'replied';

/** Coarse sentiment inferred from the message text (display hint only). */
export type Sentiment = 'positive' | 'neutral' | 'negative';

type BadgeTone = NonNullable<StatusBadgeProps['tone']>;

const STATUS_META: Record<OfflineStatus, { label: string; tone: BadgeTone }> = {
  new: { label: 'New', tone: 'accent' },
  read: { label: 'Read', tone: 'neutral' },
  replied: { label: 'Replied', tone: 'success' },
};

/** Map a raw status string to a labelled, toned badge descriptor. */
export function statusBadge(status: string | null | undefined): { label: string; tone: BadgeTone } {
  if (status && status in STATUS_META) {
    return STATUS_META[status as OfflineStatus];
  }
  return { label: 'New', tone: 'accent' };
}

const SENTIMENT_META: Record<Sentiment, { label: string; tone: BadgeTone }> = {
  positive: { label: 'Positive', tone: 'success' },
  neutral: { label: 'Neutral', tone: 'neutral' },
  negative: { label: 'Needs attention', tone: 'danger' },
};

const NEGATIVE_WORDS = [
  'problem',
  'issue',
  'broken',
  'error',
  'fail',
  'frustrated',
  'angry',
  'terrible',
  'bad',
  'wrong',
  'not working',
  'cannot',
  "can't",
  'urgent',
  'asap',
  'refund',
  'cancel',
];
const POSITIVE_WORDS = [
  'thank',
  'great',
  'awesome',
  'love',
  'perfect',
  'excellent',
  'wonderful',
  'happy',
  'appreciate',
  'good',
  'amazing',
];

/**
 * Best-effort sentiment for a message body. Lightweight keyword heuristic (ported
 * from the legacy inbox) — a display cue to help operators triage, never a
 * source of truth.
 */
export function detectSentiment(text: string | null | undefined): Sentiment {
  if (!text) return 'neutral';
  const lower = text.toLowerCase();
  const neg = NEGATIVE_WORDS.filter((w) => lower.includes(w)).length;
  const pos = POSITIVE_WORDS.filter((w) => lower.includes(w)).length;
  if (neg > pos) return 'negative';
  if (pos > neg) return 'positive';
  return 'neutral';
}

/** Presentation descriptor for a sentiment value. */
export function sentimentBadge(sentiment: Sentiment): { label: string; tone: BadgeTone } {
  return SENTIMENT_META[sentiment];
}

/** Uppercase initials (max 2) for an avatar, falling back to a person glyph. */
export function initials(name: string | null | undefined): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return parts
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** Compact relative time, e.g. "just now", "5m ago", "3h ago", "2d ago". */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  if (diff < MINUTE) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  if (diff < 7 * DAY) return `${Math.floor(diff / DAY)}d ago`;
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Absolute, human date-time for the detail pane. */
export function absoluteTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Substitute `{name}` in a reply template with the visitor's first name. */
export function applyTemplate(body: string, visitorName: string | null | undefined): string {
  const first = (visitorName ?? '').trim().split(/\s+/)[0] || 'there';
  return body.replace(/\{name\}/g, first);
}

/**
 * Build a `mailto:` href that pre-fills a reply. Returns null when there is no
 * address to reply to (the caller then disables the reply affordance).
 */
export function buildReplyHref(
  email: string | null | undefined,
  subject: string,
  body: string,
): string | null {
  if (!email) return null;
  return `mailto:${email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
