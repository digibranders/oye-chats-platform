import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SegmentedControl } from './SegmentedControl';

/**
 * This control is the only thing standing between a keyboard or screen-reader
 * user and the time window a page is showing, so what's pinned here is the
 * ARIA radio-group contract itself: exactly one segment checked, exactly one
 * segment in the tab order, and arrow / Home / End moving the selection (which
 * follows focus) with a wrap at both ends. Two call sites share this - a
 * regression here would silently reach both.
 */

const STRING_OPTIONS = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: 'all', label: 'All time' },
] as const;

const NUMBER_OPTIONS = [
  { value: 7, label: '7 days' },
  { value: 30, label: '30 days' },
  { value: 90, label: '90 days' },
] as const;

type StringRange = (typeof STRING_OPTIONS)[number]['value'];

/** Render with a spy `onChange` and hand back both the spy and the group. */
function setup(value: StringRange = '30d') {
  const onChange = vi.fn<(next: StringRange) => void>();
  render(
    <SegmentedControl
      options={STRING_OPTIONS}
      value={value}
      onChange={onChange}
      ariaLabel="Trend window"
    />,
  );
  return { onChange, group: screen.getByRole('radiogroup', { name: 'Trend window' }) };
}

describe('SegmentedControl', () => {
  it('is a radio group with only the selected option checked', () => {
    const { group } = setup();
    const options = within(group).getAllByRole('radio');

    expect(options).toHaveLength(4);
    expect(within(group).getByRole('radio', { name: '30 days' })).toBeChecked();
    expect(options.filter((option) => option.getAttribute('aria-checked') === 'true')).toHaveLength(
      1,
    );
  });

  it('keeps a roving tabIndex so the group is a single tab stop', () => {
    const { group } = setup();

    expect(within(group).getByRole('radio', { name: '30 days' })).toHaveAttribute('tabindex', '0');
    for (const name of ['7 days', '90 days', 'All time']) {
      expect(within(group).getByRole('radio', { name })).toHaveAttribute('tabindex', '-1');
    }
  });

  it('reports the clicked option', () => {
    const { onChange } = setup();

    fireEvent.click(screen.getByRole('radio', { name: '90 days' }));

    expect(onChange).toHaveBeenCalledWith('90d');
  });

  it.each([
    ['ArrowRight', '90d'],
    ['ArrowDown', '90d'],
    ['ArrowLeft', '7d'],
    ['ArrowUp', '7d'],
  ])('moves the selection with %s', (key, expected) => {
    const { onChange } = setup();

    fireEvent.keyDown(screen.getByRole('radio', { name: '30 days' }), { key });

    expect(onChange).toHaveBeenCalledWith(expected);
  });

  it('wraps at both ends', () => {
    const { onChange } = setup('all');
    fireEvent.keyDown(screen.getByRole('radio', { name: 'All time' }), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('7d');

    onChange.mockClear();
    const first = screen.getByRole('radio', { name: '7 days' });
    fireEvent.keyDown(first, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenCalledWith('all');
  });

  it('jumps to the first and last option with Home and End', () => {
    const { onChange } = setup();

    fireEvent.keyDown(screen.getByRole('radio', { name: '30 days' }), { key: 'Home' });
    expect(onChange).toHaveBeenCalledWith('7d');

    onChange.mockClear();
    fireEvent.keyDown(screen.getByRole('radio', { name: '30 days' }), { key: 'End' });
    expect(onChange).toHaveBeenCalledWith('all');
  });

  it('moves DOM focus along with the selection', () => {
    const { group } = setup();

    fireEvent.keyDown(within(group).getByRole('radio', { name: '30 days' }), { key: 'ArrowRight' });

    expect(within(group).getByRole('radio', { name: '90 days' })).toHaveFocus();
  });

  it('ignores keys it does not own', () => {
    const { onChange } = setup();

    fireEvent.keyDown(screen.getByRole('radio', { name: '30 days' }), { key: 'a' });

    expect(onChange).not.toHaveBeenCalled();
  });

  it('disables every option when disabled', () => {
    const onChange = vi.fn<(next: number) => void>();
    render(
      <SegmentedControl
        options={NUMBER_OPTIONS}
        value={30}
        onChange={onChange}
        ariaLabel="Reporting window"
        disabled
      />,
    );

    const group = screen.getByRole('radiogroup', { name: 'Reporting window' });
    for (const option of within(group).getAllByRole('radio')) {
      expect(option).toBeDisabled();
    }

    fireEvent.click(within(group).getByRole('radio', { name: '7 days' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('carries numeric option values through unchanged', () => {
    const onChange = vi.fn<(next: number) => void>();
    render(
      <SegmentedControl
        options={NUMBER_OPTIONS}
        value={30}
        onChange={onChange}
        ariaLabel="Reporting window"
      />,
    );

    fireEvent.keyDown(screen.getByRole('radio', { name: '30 days' }), { key: 'End' });

    expect(onChange).toHaveBeenCalledWith(90);
  });
});
