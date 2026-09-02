import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { JourneyOutcome } from './journeyModel';
import { JourneyOutcomesDonut } from './JourneyOutcomesDonut';

/**
 * The buckets are not a partition. `summary_counts` increments once per event
 * type a session produced, so the ordinary out-of-hours flow (ask for a person,
 * get nobody, leave a message) is counted in `handoff_requested` AND
 * `offline_message_sent`. Drawn end to end on one circumference those arcs
 * overpainted, and the screen-reader shares summed past 100%.
 */
const overlapping: readonly JourneyOutcome[] = [
  { id: 'meeting_booked', label: 'Meeting booked', sessions: 2, share: 0.2, filterable: true },
  {
    id: 'handoff_requested',
    label: 'Live chat',
    sessions: 6,
    share: 0.6,
    filterable: true,
  },
  {
    id: 'offline_message_sent',
    label: 'Offline message',
    sessions: 6,
    share: 0.6,
    filterable: true,
  },
  { id: 'exit', label: 'Drop-off', sessions: 3, share: 0.3, filterable: false },
];

describe('JourneyOutcomesDonut', () => {
  it('draws proportions, not a partition', () => {
    render(<JourneyOutcomesDonut outcomes={overlapping} total={10} />);
    // No circumference to overpaint: the shares here sum to 170%, and a pie of
    // them is a drawing of something that cannot happen.
    expect(document.querySelector('svg')).toBeNull();
    expect(
      screen.getByText(/each bar is a share of all tracked conversations/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/so these do not add up to the total/i),
    ).toBeInTheDocument();
  });

  it('measures every bar against the same tracked total, stated in full', () => {
    render(<JourneyOutcomesDonut outcomes={overlapping} total={10} />);
    // And stated immediately: the donut counted its centre figure up over 1.4s,
    // so the denominator every bar is read against was wrong on arrival.
    expect(screen.getByText('10').closest('p')).toHaveTextContent('10 tracked conversations');
  });

  it('exposes the same numbers to screen readers as it draws visually', () => {
    render(<JourneyOutcomesDonut outcomes={overlapping} total={10} />);
    const table = screen.getByRole('table', { name: /journey outcomes/i });
    expect(within(table).getByRole('cell', { name: 'Meeting booked' })).toBeInTheDocument();
    expect(within(table).getByRole('cell', { name: '2' })).toBeInTheDocument();
    // The caption carries the caveat, so the shares cannot be read as a whole
    // that happens to be broken.
    expect(table).toHaveTextContent(/do not add up to 100%/i);
  });

  it('says "no data" rather than drawing an unmeasured share', () => {
    render(
      <JourneyOutcomesDonut
        outcomes={[{ id: 'exit', label: 'Drop-off', sessions: 0, share: null, filterable: false }]}
        total={0}
      />,
    );
    const table = screen.getByRole('table', { name: /journey outcomes/i });
    expect(within(table).getByRole('cell', { name: 'No data' })).toBeInTheDocument();
  });
});
