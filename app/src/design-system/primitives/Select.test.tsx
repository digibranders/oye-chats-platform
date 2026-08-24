import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Select, type SelectOption } from './Select';

/**
 * The searchable filter, which is the part of this control a caller can break
 * from the outside by passing a `search` string.
 */

const OPTIONS: SelectOption[] = [
  { value: 'ar-SA', label: 'Arabic (Saudi Arabia)', search: 'Arabic (Saudi Arabia) العربية' },
  { value: 'fr-FR', label: 'French (France)', search: 'French (France) Français (France)' },
  { value: 'hi-IN', label: 'Hindi (India)', search: 'Hindi (India) हिन्दी' },
  { value: 'en-IN', label: 'English (India)' },
];

function open(options: SelectOption[] = OPTIONS): void {
  render(<Select value="" onChange={vi.fn()} options={options} searchable aria-label="Language" />);
  fireEvent.click(screen.getByRole('combobox'));
}

function filter(query: string): string[] {
  fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: query } });
  return screen.queryAllByRole('option').map((el) => el.textContent?.trim() ?? '');
}

describe('searchable filtering', () => {
  it('matches a capitalised term against a caller-supplied search string', () => {
    // Regression: the query is lowercased, so a `search` string that was not
    // lowercased could only ever match a mid-word fragment. Searching by a
    // name's first letter - which is how anyone actually searches - returned
    // nothing. Found by driving the real Language card in a browser.
    open();
    expect(filter('arab')).toEqual(['Arabic (Saudi Arabia)']);
    expect(filter('french')).toEqual(['French (France)']);
    expect(filter('hindi')).toEqual(['Hindi (India)']);
  });

  it('is case-insensitive in both directions', () => {
    open();
    expect(filter('ARABIC')).toEqual(['Arabic (Saudi Arabia)']);
    expect(filter('Arabic')).toEqual(['Arabic (Saudi Arabia)']);
  });

  it('still matches a mid-word fragment', () => {
    open();
    expect(filter('audi')).toEqual(['Arabic (Saudi Arabia)']);
  });

  it('searches the endonym as well as the English name', () => {
    // The reason `search` carries the native name: someone looking for their
    // own language types it the way they write it.
    open();
    expect(filter('हिन्दी')).toEqual(['Hindi (India)']);
    expect(filter('Français')).toEqual(['French (France)']);
  });

  it('falls back to the label when no search string is given', () => {
    open();
    expect(filter('english')).toEqual(['English (India)']);
    expect(filter('ENGLISH')).toEqual(['English (India)']);
  });

  it('reports no matches rather than silently showing everything', () => {
    open();
    expect(filter('klingon')).toEqual([]);
    expect(screen.getByText('No matches')).toBeTruthy();
  });
});
