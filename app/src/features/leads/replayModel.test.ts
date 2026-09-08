import { describe, expect, it } from 'vitest';
import { replayMessages, sentAt } from './replayModel';
import type { TranscriptMessage } from './useLeadDetail';
import type { SessionAuditEntry } from '../../services/api';

/**
 * One conversation out of two sources.
 *
 * The drawer used to show them as two things: the messages, and an "Activity"
 * disclosure appended under the last of them. Filed at the bottom, "Operator
 * joined" explained nothing — the operator's first message still appeared out
 * of nowhere three bubbles above it.
 */

const label = (action: string) => action.replace(/_/g, ' ');

function message(over: Partial<TranscriptMessage> & Pick<TranscriptMessage, 'id'>): TranscriptMessage {
  return { role: 'user', content: 'hello', ...over } as TranscriptMessage;
}

function entry(over: Partial<SessionAuditEntry> & Pick<SessionAuditEntry, 'action'>): SessionAuditEntry {
  return { operator_id: null, details: null, created_at: null, ...over };
}

describe('replayMessages', () => {
  it('files each event at the moment it happened', () => {
    const rows = replayMessages(
      [
        message({ id: 1, content: 'is anyone there?', timestamp: '2026-08-20T09:59:00Z' }),
        message({ id: 2, role: 'operator', content: 'I am', timestamp: '2026-08-20T10:02:00Z' }),
      ],
      [
        entry({ action: 'accepted', created_at: '2026-08-20T10:01:00Z' }),
        entry({ action: 'handoff_requested', created_at: '2026-08-20T10:00:00Z' }),
      ],
      label,
    );

    expect(rows.map((row) => row.text)).toEqual([
      'is anyone there?',
      'handoff requested',
      'accepted',
      'I am',
    ]);
  });

  it('translates a role into the one the widget speaks', () => {
    const rows = replayMessages(
      [
        message({ id: 1, role: 'user' }),
        message({ id: 2, role: 'bot' }),
        message({ id: 3, role: 'operator' }),
        message({ id: 4, role: 'system' }),
      ],
      [],
      label,
    );
    expect(rows.map((row) => row.role)).toEqual(['visitor', 'bot', 'operator', 'system']);
  });

  it('reads whichever timestamp field the endpoint sent', () => {
    // `GET /chat/history` sends `timestamp`; the lead endpoint sends
    // `created_at`. This drawer renders pages from both, and reading only one
    // of them showed a blank clock on half the transcripts.
    expect(sentAt(message({ id: 1, timestamp: '2026-08-20T10:00:00Z' }))).toBe('2026-08-20T10:00:00Z');
    expect(sentAt(message({ id: 2, created_at: '2026-08-20T11:00:00Z' }))).toBe('2026-08-20T11:00:00Z');
    expect(sentAt(undefined)).toBeNull();
  });

  it('sorts on the field each row actually carries', () => {
    const rows = replayMessages(
      [
        message({ id: 1, content: 'second', created_at: '2026-08-20T10:05:00Z' }),
        message({ id: 2, content: 'first', timestamp: '2026-08-20T10:01:00Z' }),
      ],
      [],
      label,
    );
    expect(rows.map((row) => row.text)).toEqual(['first', 'second']);
  });

  it('leaves an undated row where it arrived instead of burying it', () => {
    // A message with no timestamp is a data defect, and sweeping it to the top
    // of the conversation hides it behind a scroll nobody performs.
    const rows = replayMessages(
      [
        message({ id: 1, content: 'first', timestamp: '2026-08-20T10:00:00Z' }),
        message({ id: 2, content: 'undated' }),
        message({ id: 3, content: 'third', timestamp: '2026-08-20T10:02:00Z' }),
      ],
      [],
      label,
    );
    expect(rows.map((row) => row.text)).toEqual(['first', 'undated', 'third']);
  });

  it('keys every row uniquely, including two identical events', () => {
    // Audit rows carry no id, so the key is built from what they do carry. Two
    // transfers in the same second would otherwise collide and React would drop
    // one of them.
    const rows = replayMessages(
      [message({ id: 1 })],
      [
        entry({ action: 'transferred', created_at: '2026-08-20T10:00:00Z' }),
        entry({ action: 'transferred', created_at: '2026-08-20T10:00:00Z' }),
      ],
      label,
    );
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
  });

  it('reads an empty conversation as empty, not as one blank bubble', () => {
    expect(replayMessages([], [], label)).toEqual([]);
  });
});
