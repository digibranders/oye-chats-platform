import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { LanguageBreakdown, TranslationUsage } from './LanguageBreakdown';
import { parseLanguageBreakdown, type LanguageBreakdown as Data } from './analytics-types';

/**
 * Phase 5C - language analytics on the workspace Analytics page.
 *
 * The parser tests guard the boundary (the endpoint is a loose record on the
 * client). The render tests guard the two claims these cards make that are
 * easy to get subtly wrong: that "Not detected" reads as a residual rather
 * than a language, and that rolling counters are never presented as history.
 */

const PAYLOAD = {
  bot_id: 1,
  period: '30d',
  multilingual_enabled: true,
  operator_translation_enabled: true,
  conversations: [
    { language_code: 'hi', label: 'Hindi', total: 412, resolved: 301, live_chat: 88 },
    { language_code: 'en', label: 'English', total: 120, resolved: 90, live_chat: 10 },
    { language_code: null, label: 'Not detected', total: 96, resolved: 71, live_chat: 4 },
  ],
  totals: { total: 628, resolved: 462, live_chat: 102, languages: 2 },
  translation: { requests: 1240, ok: 1198, failed: 30, timeout: 12, window_hours: 24 },
  // Deliberately unequal to `ok` above, so an assertion on the credit figure
  // cannot accidentally match the translated-message count.
  cost: { credits: 1150, period: '30d' },
};

const parsed = (over: Record<string, unknown> = {}): Data =>
  parseLanguageBreakdown({ ...PAYLOAD, ...over });

describe('parseLanguageBreakdown', () => {
  it('maps the wire shape onto the view model', () => {
    const data = parsed();
    expect(data.multilingualEnabled).toBe(true);
    expect(data.operatorTranslationEnabled).toBe(true);
    expect(data.rows).toHaveLength(3);
    expect(data.rows[0]).toEqual({
      languageCode: 'hi',
      label: 'Hindi',
      total: 412,
      resolved: 301,
      liveChat: 88,
    });
    expect(data.creditsSpent).toBe(1150);
  });

  it('keeps the server totals rather than recomputing them', () => {
    // Recomputing in the client would let a parsing quirk silently disagree
    // with the API, which is exactly the drift these cards must not have.
    const data = parsed({ totals: { total: 999, resolved: 1, live_chat: 2, languages: 7 } });
    expect(data.totals).toEqual({ total: 999, resolved: 1, liveChat: 2, languages: 7 });
  });

  it('preserves the null-language row instead of dropping it', () => {
    const residual = parsed().rows.find((row) => row.languageCode === null);
    expect(residual?.total).toBe(96);
    expect(residual?.label).toBe('Not detected');
  });

  it('survives a missing or malformed payload', () => {
    const empty = parseLanguageBreakdown({});
    expect(empty.rows).toEqual([]);
    expect(empty.totals.total).toBe(0);
    expect(empty.multilingualEnabled).toBe(false);
    expect(empty.creditsSpent).toBe(0);
    // Defaulted so the UI never renders "last 0 hours".
    expect(empty.translation.windowHours).toBe(24);
  });

  it('falls back to the code when a label is missing', () => {
    const data = parseLanguageBreakdown({
      conversations: [{ language_code: 'xx', total: 3, resolved: 0, live_chat: 0 }],
    });
    expect(data.rows[0].label).toBe('XX');
  });
});

describe('LanguageBreakdown', () => {
  it('lists each language with its share', () => {
    render(<LanguageBreakdown data={parsed()} />);
    const list = within(screen.getByRole('list'));
    expect(list.getByText('Hindi')).toBeTruthy();
    expect(list.getByText('English')).toBeTruthy();
    expect(list.getByText('412')).toBeTruthy();
    // 412 of 628.
    expect(list.getByText('66%')).toBeTruthy();
  });

  it('pins "Not detected" last however large it is', () => {
    // It is a residual, not a language. An agent that turned multilingual on
    // recently will have more of these than anything else, and sorting it
    // first would read as though most visitors spoke "Not detected".
    const data = parsed({
      conversations: [
        { language_code: null, label: 'Not detected', total: 5000, resolved: 0, live_chat: 0 },
        { language_code: 'hi', label: 'Hindi', total: 10, resolved: 0, live_chat: 0 },
      ],
      totals: { total: 5010, resolved: 0, live_chat: 0, languages: 1 },
    });
    render(<LanguageBreakdown data={data} />);
    const labels = within(screen.getByRole('list'))
      .getAllByRole('listitem')
      .map((li) => li.textContent ?? '');
    expect(labels[0]).toContain('Hindi');
    expect(labels[1]).toContain('Not detected');
  });

  it('describes the residual row rather than showing it false stats', () => {
    render(<LanguageBreakdown data={parsed()} />);
    expect(screen.getByText(/before multilingual was on/i)).toBeTruthy();
  });

  it('shows an empty state instead of an empty chart', () => {
    const data = parsed({
      conversations: [],
      totals: { total: 0, resolved: 0, live_chat: 0, languages: 0 },
    });
    render(<LanguageBreakdown data={data} />);
    expect(screen.getByText(/no conversations yet/i)).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });
});

describe('TranslationUsage', () => {
  it('labels rolling activity as a window, never as history', () => {
    // The counters expire at ~26h. Presenting them as period totals would
    // misreport usage by however long the customer had been running.
    render(<TranslationUsage data={parsed()} />);
    expect(screen.getByText(/last 24 hours/i)).toBeTruthy();
    expect(screen.getByText(/counters expire/i)).toBeTruthy();
  });

  it('separates durable credit cost from the rolling counters', () => {
    render(<TranslationUsage data={parsed()} />);
    expect(screen.getByText(/credits spent/i)).toBeTruthy();
    expect(screen.getByText(/does not expire/i)).toBeTruthy();
    // Asserts the card reads the ledger figure, not the rolling counter.
    expect(screen.getByText('1,150')).toBeTruthy();
    expect(screen.getByText('1,198')).toBeTruthy();
  });

  it('reports failures and timeouts together', () => {
    render(<TranslationUsage data={parsed()} />);
    // 30 failed + 12 timed out.
    expect(screen.getByText('42')).toBeTruthy();
    expect(screen.getByText(/failed or timed out/i)).toBeTruthy();
  });

  it('says nothing was translated rather than showing a 0% success rate', () => {
    const data = parsed({
      translation: { requests: 0, ok: 0, failed: 0, timeout: 0, window_hours: 24 },
    });
    render(<TranslationUsage data={data} />);
    expect(screen.getByText(/no messages translated in this window/i)).toBeTruthy();
  });

  it('never claims to report token usage', () => {
    // `translation_tokens_*` are counted without a bot_id, so per-agent token
    // figures do not exist. Showing the platform-wide number on a per-agent
    // screen would be worse than showing nothing.
    render(<TranslationUsage data={parsed()} />);
    expect(screen.queryByText(/token/i)).toBeNull();
  });
});
