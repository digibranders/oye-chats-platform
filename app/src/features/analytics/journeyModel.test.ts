import { describe, expect, it } from 'vitest';
import {
  buildOutcomes,
  deriveDropOffTotal,
  dropOffTooltip,
  filterEmptyDescription,
  isFilterableOutcome,
  outcomeLabel,
  type DropOffInput,
} from './journeyModel';

/**
 * The Journeys diagram used to derive "Drop-off / Exit" by whole-bucket set
 * subtraction: take every pre-chat sequence, remove any sequence that also
 * appeared in a conversion path, and call the survivors drop-offs.
 *
 * That was wrong in three compounding ways, and wrong in a customer-facing
 * analytics surface:
 *   1. `preChatSequences.sequences[].sessions` is the pattern's TOTAL session
 *      count (converted AND not). A 200-session path with ONE booked meeting
 *      was deleted from drop-off entirely.
 *   2. Surviving rows were rendered with their FULL session count and labelled
 *      "drop-off", when only a slice of those sessions actually dropped off.
 *   3. `conversionPaths` is fetched with `limit: 5` per outcome, so any
 *      conversion outside the top 5 was invisible to the subtraction and its
 *      sessions were double-counted as drop-offs.
 *
 * The backend already computes the honest answer per session
 * (`summary.sessions_no_activity`, no conversion event AND no post-chat page),
 * so the total is read, never derived. Per-JOURNEY drop-off attribution has no
 * backend support at all, so it must not be invented on the client.
 */

function input(over: Partial<DropOffInput['summary']> & { postChat?: number } = {}): DropOffInput {
  const { postChat = 0, ...summary } = over;
  return {
    summary: {
      sessions_with_journey: 0,
      meeting_booked: 0,
      handoff_requested: 0,
      offline_message_sent: 0,
      ...summary,
    },
    postChat: { sessions_with_post_chat_activity: postChat },
  };
}

describe('deriveDropOffTotal', () => {
  it('reports the backend count verbatim when it is present', () => {
    expect(
      deriveDropOffTotal(
        input({ sessions_with_journey: 500, meeting_booked: 40, sessions_no_activity: 137, postChat: 300 }),
      ),
    ).toEqual({ count: 137, basis: 'reported' });
  });

  it('does not let one conversion erase a high-traffic bucket', () => {
    // The headline regression: 200 sessions on a single pre-chat pattern,
    // exactly ONE of which booked a meeting. Bucket subtraction dropped all
    // 200 from the drop-off view; the honest per-session count is 180.
    // The kept-browsing figure (25) is deliberately NOT 200 − 1 − 180, so a
    // regression that ignores the reported field and subtracts instead lands
    // on a visibly different number (174) rather than coinciding with 180.
    const out = deriveDropOffTotal(
      input({ sessions_with_journey: 200, meeting_booked: 1, sessions_no_activity: 180, postChat: 25 }),
    );
    expect(out.count).toBe(180);
    expect(out.basis).toBe('reported');
  });

  it('treats a reported zero as reported, not as a missing field', () => {
    // `sessions_no_activity: 0` is a real answer ("every session did
    // something"). A truthiness check here would silently fall through to the
    // estimate and print a different number for the same window.
    expect(
      deriveDropOffTotal(
        input({ sessions_with_journey: 10, meeting_booked: 2, sessions_no_activity: 0, postChat: 3 }),
      ),
    ).toEqual({ count: 0, basis: 'reported' });
  });

  it('falls back to a clamped subtraction, flagged as an estimate', () => {
    // Older API builds omit the field. 100 sessions − 10 conversions − 30
    // kept-browsing = 60, but any session that both converted AND kept
    // browsing is subtracted twice, so the estimate is a LOWER bound.
    expect(
      deriveDropOffTotal(
        input({ sessions_with_journey: 100, meeting_booked: 6, handoff_requested: 3, offline_message_sent: 1, postChat: 30 }),
      ),
    ).toEqual({ count: 60, basis: 'estimated' });
  });

  it('never reports a negative drop-off from the fallback', () => {
    // Every session both converted and kept browsing: the double subtraction
    // goes negative. A negative visitor count must never reach the screen.
    expect(
      deriveDropOffTotal(input({ sessions_with_journey: 10, meeting_booked: 10, postChat: 10 })),
    ).toEqual({ count: 0, basis: 'estimated' });
  });
});

describe('dropOffTooltip', () => {
  it('states the definition without hedging when the count is reported', () => {
    const text = dropOffTooltip({ count: 137, basis: 'reported' });
    expect(text).toContain('137');
    expect(text.toLowerCase()).not.toContain('estimate');
  });

  it('says the number is an estimate and which way it is wrong when derived', () => {
    const text = dropOffTooltip({ count: 60, basis: 'estimated' });
    expect(text.toLowerCase()).toContain('estimate');
    // The fallback subtracts overlapping sessions twice, so the true drop-off
    // can only be equal or higher. Saying so is the whole point of the label.
    expect(text.toLowerCase()).toContain('higher');
  });
});

describe('isFilterableOutcome', () => {
  it('accepts the three outcomes the backend attributes pre-chat paths for', () => {
    expect(isFilterableOutcome('meeting_booked')).toBe(true);
    expect(isFilterableOutcome('handoff_requested')).toBe(true);
    expect(isFilterableOutcome('offline_message_sent')).toBe(true);
  });

  it('rejects drop-off, no per-journey exit attribution exists', () => {
    // This is the guard that keeps the old bug unrepresentable: there is no
    // endpoint returning "which pre-chat journeys ended in an exit", so the
    // diagram must never claim to filter by one.
    expect(isFilterableOutcome('exit')).toBe(false);
  });

  it('rejects unknown ids', () => {
    expect(isFilterableOutcome('lead_captured')).toBe(false);
    expect(isFilterableOutcome('')).toBe(false);
  });
});

describe('outcomeLabel', () => {
  it('maps known outcome ids to their card labels', () => {
    expect(outcomeLabel('meeting_booked')).toBe('Meeting booked');
    expect(outcomeLabel('handoff_requested')).toBe('Live chat');
    expect(outcomeLabel('offline_message_sent')).toBe('Offline message');
    expect(outcomeLabel('exit')).toBe('Drop-off');
  });

  it('passes an unknown id through rather than inventing a name', () => {
    expect(outcomeLabel('something_new')).toBe('something_new');
  });
});

describe('filterEmptyDescription', () => {
  it('says "nothing was tracked" when there is no journey data at all', () => {
    const text = filterEmptyDescription({
      outcome: 'handoff_requested',
      startPage: null,
      hasTrackedJourneys: false,
    });
    expect(text.toLowerCase()).toContain('no page journeys were tracked');
    // "No data" and "data exists, none matched" are different facts. The old
    // copy asserted the second one in both cases.
    expect(text.toLowerCase()).not.toContain('attributed to');
  });

  it('reports an unmatched outcome filter when journeys do exist', () => {
    // Deliberately "attributed to", not "ended in": a conversion whose
    // session had no tracked pre-chat page still counts on the outcome card
    // but has no path to draw, so claiming none ended in it would be false.
    expect(
      filterEmptyDescription({
        outcome: 'handoff_requested',
        startPage: null,
        hasTrackedJourneys: true,
      }),
    ).toBe('No tracked journeys are attributed to Live chat in this window.');
  });

  it('mentions the starting page when both filters are active', () => {
    expect(
      filterEmptyDescription({
        outcome: 'meeting_booked',
        startPage: '/pricing',
        hasTrackedJourneys: true,
      }),
    ).toBe('No tracked journeys are attributed to Meeting booked in this window starting on /pricing.');
  });

  it('reports an unmatched starting-page filter on its own', () => {
    expect(
      filterEmptyDescription({ outcome: null, startPage: '/blog', hasTrackedJourneys: true }),
    ).toBe('No tracked journeys started on /blog in this window.');
  });

  it('falls back to a neutral sentence when no filter is identifiable', () => {
    expect(
      filterEmptyDescription({ outcome: null, startPage: null, hasTrackedJourneys: true }),
    ).toBe('No tracked journeys match the current filters.');
  });
});

/**
 * The two journey panels used to compute drop-off separately, from different
 * inputs, so two cards a few pixels apart could report different totals with
 * nothing reconciling them. `buildOutcomes` is now the only thing that decides
 * what the outcome column says, and both panels render what it returns.
 */
describe('buildOutcomes', () => {
  const summary = {
    sessions_with_journey: 100,
    meeting_booked: 10,
    handoff_requested: 5,
    offline_message_sent: 5,
    sessions_no_activity: 60,
    sessions_browsed_no_conversion: 20,
    leads_captured: 12,
  };

  it('reports every bucket with its share of tracked journeys', () => {
    const outcomes = buildOutcomes({ summary, postChat: { sessions_with_post_chat_activity: 20 } });
    expect(outcomes.map((outcome) => outcome.id)).toEqual([
      'meeting_booked',
      'handoff_requested',
      'offline_message_sent',
      'kept_browsing',
      'exit',
    ]);
    expect(outcomes[0].share).toBeCloseTo(0.1);
    expect(outcomes.find((outcome) => outcome.id === 'exit')?.sessions).toBe(60);
  });

  it('only lets the three attributed outcomes be used as a filter', () => {
    const outcomes = buildOutcomes({ summary, postChat: { sessions_with_post_chat_activity: 20 } });
    expect(outcomes.filter((outcome) => outcome.filterable).map((outcome) => outcome.id)).toEqual([
      'meeting_booked',
      'handoff_requested',
      'offline_message_sent',
    ]);
    // Drop-off and "kept browsing" have no path attribution behind them, so
    // they say why rather than offering a filter that would return nothing.
    expect(outcomes.find((outcome) => outcome.id === 'exit')?.note).toBeTruthy();
  });

  it('omits "kept browsing" rather than estimating it on an older API build', () => {
    const { sessions_browsed_no_conversion: _omitted, ...older } = summary;
    const outcomes = buildOutcomes({
      summary: older,
      postChat: { sessions_with_post_chat_activity: 20 },
    });
    expect(outcomes.some((outcome) => outcome.id === 'kept_browsing')).toBe(false);
  });

  it('has no share to report when nothing was tracked', () => {
    const outcomes = buildOutcomes({
      summary: { ...summary, sessions_with_journey: 0 },
      postChat: { sessions_with_post_chat_activity: 0 },
    });
    expect(outcomes.every((outcome) => outcome.share === null)).toBe(true);
  });
});
