import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DatePicker } from './DatePicker';

/**
 * The keyboard contract `app/CLAUDE.md` #1 asks every `src/ui/` primitive to
 * carry, for the calendar grid this replaces `<input type="date">` with — see
 * the component's own docblock for why the native picker had to go.
 */

function Controlled({
  initial = null,
  min,
  max,
  clearable,
}: {
  initial?: string | null;
  min?: string;
  max?: string;
  clearable?: boolean;
}) {
  const [value, setValue] = useState<string | null>(initial);
  return (
    <DatePicker
      label="Date captured"
      value={value}
      onValueChange={setValue}
      min={min}
      max={max}
      clearable={clearable}
    />
  );
}

/** The trigger's own accessible name — the label, plus the picked date once
 * there is one. See the component's `accessibleName` note for why. */
function trigger(nameMatch: string | RegExp = 'Date captured') {
  return screen.getByRole('button', { name: nameMatch });
}

async function openOn(user: ReturnType<typeof userEvent.setup>, nameMatch: string | RegExp = 'Date captured') {
  await user.click(trigger(nameMatch));
  return screen.findByRole('grid');
}

/**
 * The clock is pinned for the whole file.
 *
 * A picker with no value opens on the CURRENT month, so the one test that
 * starts empty was clicking a day that only existed while the machine's date
 * was in August 2026. It passed for a month and then failed on 1 September on
 * a commit that touched nothing in `app/` — a red build that names a date
 * component and blames whoever pushed that morning.
 *
 * Every other test here escapes it by passing `initial`, which forces the month
 * open. That is not available to this one: what it asserts is the EMPTY state,
 * so giving it a value would delete the thing under test. Pinning the clock is
 * what makes "opens on today" testable at all.
 */
const TODAY = new Date('2026-08-15T12:00:00.000Z');

beforeAll(() => {
  // `shouldAdvanceTime` so `userEvent`'s internal delays still resolve; without
  // it every `await user.click()` in this file hangs on a frozen clock.
  vi.useFakeTimers({ shouldAdvanceTime: true, now: TODAY });
});

afterAll(() => {
  vi.useRealTimers();
});

describe('DatePicker', () => {
  it('shows a placeholder until a date is picked, and folds the picked date into its own name after', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<Controlled />);
    expect(trigger()).toHaveTextContent('Select a date');

    await openOn(user);
    await user.click(screen.getByRole('button', { name: '15 August 2026' }));

    expect(screen.queryByRole('grid')).not.toBeInTheDocument();
    expect(trigger('Date captured, 15 August 2026')).toHaveTextContent('15 August 2026');
  });

  it('opens on the selected day’s month and marks it selected', async () => {
    const user = userEvent.setup();
    render(<Controlled initial="2026-08-15" />);
    const grid = await openOn(user, /15 August 2026/);
    expect(screen.getByRole('grid', { name: 'August 2026' })).toBeInTheDocument();
    expect(within(grid).getByRole('gridcell', { selected: true })).toBe(
      screen.getByRole('button', { name: '15 August 2026' }).closest('[role="gridcell"]'),
    );
    await user.keyboard('{Escape}');
  });

  it('moves the active cell with the arrow keys', async () => {
    const user = userEvent.setup();
    render(<Controlled initial="2026-08-15" />);
    await openOn(user, /15 August 2026/);

    // Opening focuses the selected day (15th); each arrow moves exactly one
    // step in its direction, crossing week and month boundaries like any
    // other calendar-grid day picker.
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('button', { name: '16 August 2026' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('button', { name: '23 August 2026' })).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('button', { name: '22 August 2026' })).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('button', { name: '15 August 2026' })).toHaveFocus();
    await user.keyboard('{Escape}');
  });

  it('Home and End jump to the edges of the visible month', async () => {
    const user = userEvent.setup();
    render(<Controlled initial="2026-08-15" />);
    await openOn(user, /15 August 2026/);

    await user.keyboard('{Home}');
    expect(screen.getByRole('button', { name: '1 August 2026' })).toHaveFocus();
    await user.keyboard('{End}');
    expect(screen.getByRole('button', { name: '31 August 2026' })).toHaveFocus();
    await user.keyboard('{Escape}');
  });

  it('PageUp and PageDown step to the adjacent month, keeping the day', async () => {
    const user = userEvent.setup();
    render(<Controlled initial="2026-08-15" />);
    await openOn(user, /15 August 2026/);

    await user.keyboard('{PageDown}');
    expect(screen.getByRole('grid', { name: 'September 2026' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '15 September 2026' })).toHaveFocus();

    await user.keyboard('{PageUp}');
    await user.keyboard('{PageUp}');
    expect(screen.getByRole('grid', { name: 'July 2026' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '15 July 2026' })).toHaveFocus();
    await user.keyboard('{Escape}');
  });

  it('Enter commits the active day and closes the panel', async () => {
    const user = userEvent.setup();
    render(<Controlled initial="2026-08-15" />);
    await openOn(user, /15 August 2026/);

    // Each key its own `keyboard()` call: a combined string dispatches all
    // three before React's effect-driven refocus for the first ArrowRight
    // settles, so `Enter` would fire against a stale `activeDay` closure —
    // exactly the interleaving a real user's separate keystrokes never produce.
    await user.keyboard('{ArrowRight}');
    await user.keyboard('{ArrowRight}');
    await user.keyboard('{Enter}');
    expect(screen.queryByRole('grid')).not.toBeInTheDocument();
    expect(trigger(/17 August 2026/)).toBeInTheDocument();
  });

  it('Escape closes without changing the selection', async () => {
    const user = userEvent.setup();
    render(<Controlled initial="2026-08-15" />);
    await openOn(user, /15 August 2026/);

    await user.keyboard('{ArrowRight}');
    await user.keyboard('{ArrowRight}');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('grid')).not.toBeInTheDocument();
    expect(trigger(/15 August 2026/)).toBeInTheDocument();
  });

  it('refuses a day outside min/max: unreachable via Enter, and marked unavailable', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <DatePicker
        label="Date captured"
        value="2026-08-15"
        onValueChange={onValueChange}
        min="2026-08-10"
        max="2026-08-20"
      />,
    );
    await openOn(user, /15 August 2026/);

    const beforeMin = screen.getByRole('button', { name: '9 August 2026' });
    expect(beforeMin).toHaveAttribute('aria-disabled', 'true');
    await user.click(beforeMin);
    expect(onValueChange).not.toHaveBeenCalled();

    // Still reachable by keyboard — a disabled-but-focusable cell, not one
    // dropped from the grid, so the boundary is announced rather than silent.
    await user.keyboard('{Home}');
    await user.keyboard('{ArrowLeft}');
    await user.keyboard('{Enter}');
    expect(onValueChange).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
  });

  it('clears the value from its own control, without opening the panel', async () => {
    const user = userEvent.setup();
    render(<Controlled initial="2026-08-15" clearable />);
    await user.click(screen.getByRole('button', { name: 'Clear Date captured' }));
    expect(trigger()).toHaveTextContent('Select a date');
    expect(screen.queryByRole('grid')).not.toBeInTheDocument();
  });
});
