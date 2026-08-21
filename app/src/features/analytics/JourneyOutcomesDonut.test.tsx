import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { JourneyOutcomesDonut } from './JourneyOutcomesDonut';

const outcomes = [
  { id: 'meeting_booked', label: 'Meeting booked', sessions: 4, share: 0.4, filterable: true },
  { id: 'kept_browsing', label: 'Kept browsing', sessions: 3, share: 0.3, filterable: false },
  { id: 'exit', label: 'Drop-off / Exit', sessions: 3, share: 0.3, filterable: false },
] as const;

describe('JourneyOutcomesDonut', () => {
  it('exposes the same numbers to screen readers as it draws visually', () => {
    render(<JourneyOutcomesDonut outcomes={outcomes as any} total={10} />);
    // The decorative SVG is hidden from the accessibility tree...
    const svg = document.querySelector('svg[aria-hidden="true"]');
    expect(svg).toBeInTheDocument();
    // ...but a real data table carries the same facts for screen readers.
    const table = screen.getByRole('table', { name: /journey outcomes/i });
    expect(table).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Meeting booked' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '4' })).toBeInTheDocument();
  });
});
