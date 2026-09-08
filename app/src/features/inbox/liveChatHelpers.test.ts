import { describe, expect, it } from 'vitest';

import { parseHistoryMessage } from './liveChatHelpers';
import type { ChatMessage } from '../../types/domain';

/**
 * The parser that rebuilds a transcript from REST history, and the one field
 * it was reading under the wrong name.
 *
 * `GET /chat/history` serialises a message's time as `timestamp`. This read
 * `created_at`, which that endpoint never sends, so every message the console
 * restored from history carried `timestamp: null` — every message in a Waiting
 * or AI-handled conversation, and the whole first page of a live one.
 *
 * Nothing looked broken, because the four things that depend on the value all
 * fail quietly: the clock under a message renders only when there is one, the
 * day divider needs two dates to find a boundary, grouping compares two
 * timestamps and treats a null pair as "different runs" (so every message
 * became its own group, with its own avatar and a full gap), and the read
 * receipt refuses to mark a message seen without a time to compare. An
 * operator saw sixteen avatars, no clocks, and no "Seen" after a reload.
 *
 * Both names are accepted rather than just the right one: the lead drawer
 * renders pages from this endpoint AND from the lead endpoint, which really
 * does send `created_at`, and it has always read `timestamp ?? created_at`.
 * Matching that shape here is what stops the two consoles disagreeing again.
 */
describe('parseHistoryMessage', () => {
  const base: ChatMessage = { id: 1, role: 'user', content: 'hello' };

  it('reads the field the history endpoint actually sends', () => {
    const parsed = parseHistoryMessage({ ...base, timestamp: '2026-09-08T10:56:00Z' });
    expect(parsed.timestamp).toBe('2026-09-08T10:56:00Z');
  });

  it('still reads the field the lead endpoint sends', () => {
    const parsed = parseHistoryMessage({ ...base, created_at: '2026-09-08T10:57:00Z' });
    expect(parsed.timestamp).toBe('2026-09-08T10:57:00Z');
  });

  it('prefers the history endpoint when a payload carries both', () => {
    // Not arbitrary: this parser is only ever fed by the history endpoint, so
    // its own field is the authority when something upstream sends two.
    const parsed = parseHistoryMessage({
      ...base,
      timestamp: '2026-09-08T10:56:00Z',
      created_at: '1999-01-01T00:00:00Z',
    });
    expect(parsed.timestamp).toBe('2026-09-08T10:56:00Z');
  });

  it('carries null rather than inventing a time', () => {
    // A message with no time is a data problem, and the transcript already
    // renders that honestly: no clock, no divider, no run grouped around it.
    // Substituting "now" would date a two-week-old message to this afternoon.
    expect(parseHistoryMessage(base).timestamp).toBeNull();
  });

  it('times a file message too, which takes the other branch of the parser', () => {
    // The attachment path rewrites `content`, `fileUrl` and `filename` after
    // the base object is built. A regression that dropped the timestamp only
    // on attachments would be invisible in every other case here.
    const parsed = parseHistoryMessage({
      ...base,
      content: '[File: quote.pdf](https://cdn.example.com/quote.pdf)',
      timestamp: '2026-09-08T11:02:00Z',
    });
    expect(parsed.timestamp).toBe('2026-09-08T11:02:00Z');
    expect(parsed.fileUrl).toBe('https://cdn.example.com/quote.pdf');
    expect(parsed.filename).toBe('quote.pdf');
  });
});
