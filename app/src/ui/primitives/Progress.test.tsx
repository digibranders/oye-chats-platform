import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Meter } from './Progress';

/**
 * A meter whose ceiling is zero.
 *
 * `Meter` escalates its tone with the fraction, and the fraction was forced to
 * `0` whenever `limit === 0`. So "1 / 0 seats", a workspace holding an
 * operator on a plan that allows none, which is exactly what a downgrade
 * leaves behind, painted a calm empty bar, while "11 / 10" painted the danger
 * state it deserved. The one that is further over its ceiling read as the safer
 * of the two.
 *
 * A zero ceiling with nothing used is a different fact: nothing is over
 * anything, so it stays neutral.
 */

function meterFill(): HTMLElement | null {
  return screen.getByRole('meter').querySelector('[style*="width"]');
}

describe('Meter over a zero limit', () => {
  it('paints the over-limit state when something is used against a limit of zero', () => {
    render(<Meter label="Seats" used={1} limit={0} unit="seats" />);

    const fill = meterFill();
    expect(fill).not.toBeNull();
    expect(fill?.className).toContain('bg-danger-fill');
    expect(fill?.style.width).toBe('100%');
    // The figure keeps the real numbers: "1 / 0" is the fact, not a rounding.
    expect(screen.getByRole('meter').getAttribute('aria-valuetext')).toContain('1 of 0 used');
    expect(screen.getByRole('meter').getAttribute('aria-valuetext')).toContain('100%');
  });

  it('leaves a zero limit with nothing used calm and empty', () => {
    render(<Meter label="Seats" used={0} limit={0} unit="seats" />);

    const fill = meterFill();
    expect(fill?.className).toContain('bg-accent-500');
    expect(fill?.className).not.toContain('bg-danger-fill');
    expect(fill?.style.width).toBe('0%');
  });

  it('still escalates over a positive limit, and still leaves room below it', () => {
    const { unmount } = render(<Meter label="Seats" used={11} limit={10} />);
    expect(meterFill()?.className).toContain('bg-danger-fill');
    unmount();

    render(<Meter label="Seats" used={4} limit={10} />);
    expect(meterFill()?.className).toContain('bg-accent-500');
  });

  it('keeps an unlimited allowance out of the escalation entirely', () => {
    render(<Meter label="Seats" used={9} limit={-1} unlimitedNote="No limit" />);
    // The unlimited branch renders a bare track and no `meter` role, so there is
    // no fraction to escalate and nothing to paint red.
    expect(screen.queryByRole('meter')).toBeNull();
    expect(screen.getByText('No limit')).toBeInTheDocument();
  });
});
