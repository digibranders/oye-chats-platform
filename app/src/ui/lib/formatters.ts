/**
 * Formatting for everything the console displays as a figure.
 *
 * Centralised for two reasons. Consistency: a credit balance must read the same
 * on Home, in Billing and in the sidebar. And absence: a value that does not
 * exist renders as an em dash, never as "0", "null" or an empty cell, because
 * "no invoice was issued" and "an invoice for zero" are different facts and a
 * blank cell makes the reader guess which one they are looking at.
 */

/** The console's placeholder for a value that is not there. */
export const ABSENT = '—';

const nf = new Intl.NumberFormat('en-US');
const nfCompact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

/** A plain integer with thousands separators. */
export function formatNumber(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? ABSENT : nf.format(value);
}

/** `12.4K`, for a figure that has to fit in a stat tile or an axis tick. */
export function formatCompact(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? ABSENT : nfCompact.format(value);
}

/**
 * Money, in the currency the account is actually charged in.
 *
 * The account's charge currency comes from the server, so the caller passes it
 * rather than the formatter assuming INR: a USD-billed workspace shown "₹" is a
 * support ticket, not a rounding error.
 */
export function formatMoney(
  minorUnits: number | null | undefined,
  currency: string,
  options: { showDecimals?: boolean } = {},
): string {
  if (minorUnits == null || !Number.isFinite(minorUnits)) return ABSENT;
  const major = minorUnits / 100;
  // Whole amounts drop their decimals so a table of prices stays scannable;
  // anything with paise or cents keeps them, because rounding money silently is
  // how a reconciliation argument starts.
  const showDecimals = options.showDecimals ?? !Number.isInteger(major);
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: showDecimals ? 2 : 0,
    maximumFractionDigits: showDecimals ? 2 : 0,
  }).format(major);
}

/** `42%`. Takes a 0–1 fraction, not an already-multiplied number. */
export function formatPercent(
  fraction: number | null | undefined,
  fractionDigits = 0,
): string {
  if (fraction == null || !Number.isFinite(fraction)) return ABSENT;
  return new Intl.NumberFormat('en-US', {
    style: 'percent',
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(fraction);
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** File sizes for the knowledge base's upload list. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return ABSENT;
  if (bytes === 0) return '0 B';
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), BYTE_UNITS.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${BYTE_UNITS[exponent]}`;
}

function toDate(value: string | number | Date | null | undefined): Date | null {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** `19 Aug 2026` — unambiguous in every locale, unlike 08/19. */
export function formatDate(value: string | number | Date | null | undefined): string {
  const date = toDate(value);
  return date
    ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(date)
    : ABSENT;
}

/** `19 Aug 2026, 14:32` — for audit trails and message timestamps. */
export function formatDateTime(value: string | number | Date | null | undefined): string {
  const date = toDate(value);
  return date
    ? new Intl.DateTimeFormat('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(date)
    : ABSENT;
}

/** `14:32` — inside a conversation, where the day is already established. */
export function formatTime(value: string | number | Date | null | undefined): string {
  const date = toDate(value);
  return date
    ? new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
    : ABSENT;
}

const RELATIVE_STEPS: [limit: number, divisor: number, unit: Intl.RelativeTimeFormatUnit][] = [
  [60, 1, 'second'],
  [3600, 60, 'minute'],
  [86400, 3600, 'hour'],
  [604800, 86400, 'day'],
  [2629800, 604800, 'week'],
  [31557600, 2629800, 'month'],
  [Infinity, 31557600, 'year'],
];

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/**
 * `3 minutes ago`. Anchored on an explicit `now` so a list of rows formats
 * against one instant instead of drifting as it renders, and so tests are not
 * hostage to the clock.
 */
export function formatRelative(
  value: string | number | Date | null | undefined,
  now: Date = new Date(),
): string {
  const date = toDate(value);
  if (!date) return ABSENT;
  const seconds = (date.getTime() - now.getTime()) / 1000;
  const magnitude = Math.abs(seconds);
  if (magnitude < 30) return 'just now';
  const [, divisor, unit] = RELATIVE_STEPS.find(([limit]) => magnitude < limit) ?? RELATIVE_STEPS.at(-1)!;
  return rtf.format(Math.round(seconds / divisor), unit);
}

/** `2h 14m` — for durations like time-to-first-response. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return ABSENT;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days}d ${restHours}h` : `${days}d`;
}

/**
 * Shorten an opaque identifier for display: `bot-6a427d4529b9` → `bot-6a42…29b9`.
 * The head and tail are what a human actually matches against, and keeping both
 * ends means two adjacent keys never collapse into the same string on screen.
 */
export function truncateId(value: string | null | undefined, head = 10, tail = 4): string {
  if (!value) return ABSENT;
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}
