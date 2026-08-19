import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type {
  JourneyPostChatResponse,
  JourneyPreChatSequencesResponse,
  JourneySummary,
} from '../../services/api';
import { buildOutcomes } from './journeyModel';
import { JourneyFlow } from './JourneyFlow';

/**
 * The diagram this replaces was 2,011 lines of SVG whose nodes were
 * `foreignObject` divs carrying `onClick` and neither `role` nor `tabIndex`, so
 * filtering by outcome — its only interaction — could not be done without a
 * mouse. That is the contract under test here: every outcome that filters is a
 * real button, reachable by keyboard, reporting its own pressed state; and
 * every outcome that cannot filter is not a button at all, so nobody tabs onto
 * a control that does nothing.
 */

const summary: JourneySummary = {
  sessions_with_journey: 100,
  meeting_booked: 12,
  handoff_requested: 6,
  offline_message_sent: 2,
  sessions_no_activity: 60,
  sessions_browsed_no_conversion: 20,
  leads_captured: 9,
};

const sequences: JourneyPreChatSequencesResponse = {
  period: '2026-08',
  total_sessions: 120,
  sessions_with_pre_chat: 100,
  sequences: Array.from({ length: 9 }, (_, index) => ({
    sequence: ['/', `/page-${index}`],
    post_sequence: [],
    sessions: 20 - index,
  })),
};

const postChat: JourneyPostChatResponse = {
  period: '2026-08',
  sessions_with_post_chat_activity: 20,
  first_hops: [{ path: '/pricing', sessions: 8 }],
  all_hops: [],
  full_sequences: [],
};

function renderFlow(overrides: Partial<Parameters<typeof JourneyFlow>[0]> = {}) {
  const onSelectOutcome = vi.fn();
  render(
    <JourneyFlow
      summary={summary}
      outcomes={buildOutcomes({ summary, postChat })}
      sequences={sequences}
      postChat={postChat}
      monthLabel="August 2026"
      selectedOutcome={null}
      onSelectOutcome={onSelectOutcome}
      paths={null}
      pathsLoading={false}
      pathsError={null}
      {...overrides}
    />,
  );
  return { onSelectOutcome };
}

describe('JourneyFlow', () => {
  it('offers each attributed outcome as a real button with a pressed state', () => {
    renderFlow();
    const meeting = screen.getByRole('button', { name: /meeting booked/i });
    expect(meeting).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: /live chat/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /offline message/i })).toBeInTheDocument();
  });

  it('does not make drop-off a control, because no paths are attributed to it', () => {
    renderFlow();
    expect(screen.queryByRole('button', { name: /drop-off/i })).not.toBeInTheDocument();
    expect(screen.getByText('Drop-off')).toBeInTheDocument();
  });

  it('filters by outcome from the keyboard alone', async () => {
    const user = userEvent.setup();
    const { onSelectOutcome } = renderFlow();
    const meeting = screen.getByRole('button', { name: /meeting booked/i });
    meeting.focus();
    await user.keyboard('{Enter}');
    expect(onSelectOutcome).toHaveBeenCalledWith('meeting_booked');
  });

  it('clears a selected outcome rather than trapping the reader in it', async () => {
    const user = userEvent.setup();
    const { onSelectOutcome } = renderFlow({ selectedOutcome: 'meeting_booked' });
    await user.click(screen.getByRole('button', { name: /meeting booked/i }));
    expect(onSelectOutcome).toHaveBeenCalledWith(null);
    expect(screen.getByRole('button', { name: /clear filter/i })).toBeInTheDocument();
  });

  it('reveals the rest of the routes instead of binning them', async () => {
    const user = userEvent.setup();
    renderFlow();
    expect(screen.getAllByText(/^\/page-/)).toHaveLength(6);
    await user.click(screen.getByRole('button', { name: /show 3 more/i }));
    expect(screen.getAllByText(/^\/page-/)).toHaveLength(9);
  });

  it('announces what the filtered view is showing', () => {
    renderFlow({
      selectedOutcome: 'handoff_requested',
      paths: {
        period: '2026-08',
        conversion_type: 'handoff_requested',
        total_conversions: 6,
        total_sessions: 100,
        paths: [{ sequence: ['/', '/help'], sessions: 4, conversion_rate: 0.04 }],
      },
    });
    expect(screen.getByText(/1 route attributed to live chat/i)).toBeInTheDocument();
  });
});
