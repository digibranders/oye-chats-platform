
import { t as translateNow } from '../../i18n/i18n';
import { formatNumber } from '../../i18n/formatters';

/**
 * Pure derivations behind the Journeys diagram's outcome column.
 *
 * Kept free of React so the arithmetic that reaches a customer's screen can be
 * pinned by tests. Everything here answers one of two questions: "how many
 * sessions dropped off?" and "what may the diagram legitimately claim about
 * them?".
 */

// ── Outcome identity ────────────────────────────────────────────────────────

/**
 * The outcomes the backend attributes pre-chat page sequences to, via
 * `GET /journey/conversion-paths`. Drop-off is deliberately NOT a member:
 * there is no endpoint that returns "which pre-chat journeys ended in an
 * exit", and it cannot be reconstructed client-side (see
 * {@link deriveDropOffTotal}). Keeping the union to the three attributed
 * outcomes makes a drop-off path filter unrepresentable rather than merely
 * discouraged.
 */
export const FILTERABLE_OUTCOMES = [
  'meeting_booked',
  'handoff_requested',
  'offline_message_sent',
] as const;

export type FilterableOutcome = (typeof FILTERABLE_OUTCOMES)[number];

/** Narrow an arbitrary destination-card id to a filterable outcome. */
export function isFilterableOutcome(id: string): id is FilterableOutcome {
  return (FILTERABLE_OUTCOMES as readonly string[]).includes(id);
}

/**
 * Human-readable label for a destination-card id. Covers `exit` too, the
 * drop-off card is still rendered (with an honest total), it just cannot be
 * used as a path filter.
 */
export function outcomeLabel(id: string): string {
  switch (id) {
    case 'meeting_booked':
      return translateNow('analytics.bookMeeting') || 'Book Meeting';
    case 'handoff_requested':
      return translateNow('analytics.liveChat') || 'Live Chat';
    case 'offline_message_sent':
      return translateNow('analytics.offlineMessage') || 'Offline Message';
    case 'exit':
      return 'Drop-off';
    default:
      return id;
  }
}

// ── Drop-off total ──────────────────────────────────────────────────────────

/**
 * `reported`, the backend counted it per session (`sessions_no_activity`).
 * `estimated`, the field was absent (older API build) and we subtracted;
 * that subtraction is a lower bound, never an exact figure.
 */
export type DropOffBasis = 'reported' | 'estimated';

export interface DropOffTotal {
  readonly count: number;
  readonly basis: DropOffBasis;
}

/**
 * Structural slice of `JourneyAnalytics` this derivation needs. Declared
 * locally (rather than importing the full payload type) so tests can build a
 * case in four lines and so the function stays honest about its inputs.
 */
export interface DropOffInput {
  readonly summary: {
    readonly sessions_with_journey: number;
    readonly meeting_booked: number;
    readonly handoff_requested: number;
    readonly offline_message_sent: number;
    /** Sessions with no conversion event AND no post-chat page. */
    readonly sessions_no_activity?: number;
  };
  readonly postChat: { readonly sessions_with_post_chat_activity: number };
}

/**
 * How many sessions opened chat and then did nothing, no conversion, no
 * further page view.
 *
 * Prefers the backend's per-session count. It is the only correct source: a
 * session is a drop-off or it is not, and only the row-level journey data can
 * decide that. The fallback subtraction exists solely for API builds that
 * predate the field, and is flagged `estimated` because a session that both
 * converted AND kept browsing is subtracted twice, so it reads low.
 */
export function deriveDropOffTotal(data: DropOffInput): DropOffTotal {
  const reported = data.summary.sessions_no_activity;
  if (typeof reported === 'number') {
    return { count: Math.max(0, reported), basis: 'reported' };
  }
  const conversions =
    data.summary.meeting_booked +
    data.summary.handoff_requested +
    data.summary.offline_message_sent;
  const estimate =
    data.summary.sessions_with_journey -
    conversions -
    data.postChat.sessions_with_post_chat_activity;
  return { count: Math.max(0, estimate), basis: 'estimated' };
}

/**
 * Hover copy for the drop-off card. States the definition, and (when the
 * number is an estimate) says so and which direction it errs, so nobody
 * plans against it as if it were measured.
 */
export function dropOffTooltip(total: DropOffTotal): string {
  const count = formatNumber(total.count);
  const sessions =
    translateNow(total.count === 1 ? 'analytics.sessionOne' : 'analytics.sessionMany', { count }) ||
    `${count} session${total.count === 1 ? '' : 's'}`;
  if (total.basis === 'reported') {
    return (
      translateNow('analytics.dropOffReported', { sessions }) ||
      `${sessions} opened chat and then did nothing, no conversion and no further page views. Individual drop-off journeys aren't attributed, so this card can't be opened as a path filter.`
    );
  }
  return (
    translateNow('analytics.dropOffEstimate', { sessions }) ||
    `Estimate: ${sessions}. This API build doesn't report the exact drop-off count, so it's total sessions minus conversions minus post-chat browsing. Sessions that did both are subtracted twice, so the real figure may be higher.`
  );
}

// ── Empty-state copy ────────────────────────────────────────────────────────

export interface FilterEmptyInput {
  readonly outcome: FilterableOutcome | null;
  readonly startPage: string | null;
  /**
   * Whether the window contained ANY tracked pre-chat journey. "Nothing was
   * tracked" and "things were tracked, none matched your filter" are different
   * facts and must not share a sentence.
   */
  readonly hasTrackedJourneys: boolean;
}

/** Description for the "no journeys match this filter" state. */
export function filterEmptyDescription(input: FilterEmptyInput): string {
  if (!input.hasTrackedJourneys) {
    return translateNow('analytics.noPageJourneysWereTracked') || 'No page journeys were tracked in this window. This view needs visitors who browsed at least one page before opening chat.';
  }
  const scope = input.startPage ? ` starting on ${input.startPage}` : '';
  if (input.outcome) {
    // "Attributed to", not "ended in": a conversion whose session had no
    // tracked pre-chat page still counts on the outcome card but has no path
    // to show here. Claiming none ended in it would be false.
    return (
      translateNow('analytics.noJourneysForOutcome', {
        outcome: outcomeLabel(input.outcome),
        scope,
      }) || `No tracked journeys are attributed to ${outcomeLabel(input.outcome)} in this window${scope}.`
    );
  }
  if (input.startPage) {
    return (
      translateNow('analytics.noJourneysFromPage', { page: input.startPage }) ||
      `No tracked journeys started on ${input.startPage} in this window.`
    );
  }
  return translateNow('analytics.noTrackedJourneysMatchThe') || 'No tracked journeys match the current filters.';
}
