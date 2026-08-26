/**
 * Guards for the one thing `t()` cannot express: a sentence with an element
 * inside it.
 *
 * The failure this exists to prevent is silent. Splitting such a sentence into
 * a prefix key and a suffix key renders correctly in English and then puts the
 * clauses in the wrong order in Hindi, with nothing thrown and nothing logged.
 * These tests pin the property that makes that impossible: one key holds the
 * whole sentence, and the placeholder moves within it.
 */
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { Trans } from './Trans';
import { __resetI18nForTests, preloadDictionary, setLocale } from './i18n';

afterEach(() => {
  __resetI18nForTests();
});

describe('Trans', () => {
  it('renders the English fallback with the node substituted', () => {
    render(
      <Trans
        k="does.not.exist"
        fallback="To confirm, type {name} in the box below"
        values={{ name: <strong>Support bot</strong> }}
      />,
    );
    expect(screen.getByText('Support bot').tagName).toBe('STRONG');
    expect(document.body.textContent).toBe('To confirm, type Support bot in the box below');
  });

  it('keeps the element when the sentence reorders in Hindi', async () => {
    await preloadDictionary('hi-IN');
    setLocale('hi-IN');
    render(
      <Trans
        k="agents.toConfirmType"
        fallback="To confirm, type {name} in the box below"
        values={{ name: <strong>Support bot</strong> }}
      />,
    );
    const text = document.body.textContent ?? '';
    // The agent name survives, in an element, inside a sentence that is NOT
    // the English one - which is the whole point of keying the full sentence.
    expect(screen.getByText('Support bot').tagName).toBe('STRONG');
    expect(text).toContain('Support bot');
    expect(text).not.toContain('To confirm, type');
    // Hindi puts the typed value before the verb; English does not. If this
    // ever matches English word order the sentence was split.
    expect(text.trim().endsWith('Support bot')).toBe(false);
  });

  it('renders an unmatched placeholder literally rather than dropping it', () => {
    render(<Trans k="does.not.exist" fallback="Hello {who}, welcome" values={{}} />);
    expect(document.body.textContent).toBe('Hello {who}, welcome');
  });

  it('handles a sentence with no placeholder at all', () => {
    render(<Trans k="does.not.exist" fallback="Just words" values={{ a: <i /> }} />);
    expect(document.body.textContent).toBe('Just words');
  });

  it('substitutes every occurrence, not only the first', () => {
    render(
      <Trans k="does.not.exist" fallback="{x} and {x}" values={{ x: <b>one</b> }} />,
    );
    expect(screen.getAllByText('one')).toHaveLength(2);
  });
});
