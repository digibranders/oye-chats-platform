import type { WidgetMessage } from '../../ui';
import type { SessionAuditEntry } from '../../services/api';
import type { TranscriptMessage } from './useLeadDetail';

/**
 * A conversation, rebuilt as the visitor experienced it.
 *
 * Two sources describe one conversation and the drawer used to show them as two
 * things: the messages, and an "Activity" disclosure appended under the last of
 * them listing "Requested a person", "Operator joined", "Closed". Those are not
 * a footnote to the conversation — they are moments in it, and the visitor saw
 * them inline at the time. Filed at the bottom, they also made the operator's
 * first message look as though it had arrived out of nowhere.
 *
 * So they are interleaved here, by time, into one list.
 */

/** What a message's role is called on this side of the wire. */
function roleOf(message: TranscriptMessage): WidgetMessage['role'] {
  if (message.role === 'user') return 'visitor';
  if (message.role === 'operator') return 'operator';
  if (message.role === 'system') return 'system';
  return 'bot';
}

/**
 * When a message was sent, whichever field carried it.
 *
 * `GET /chat/history/{id}` sends `timestamp` and the lead endpoint sends
 * `created_at`, and this drawer renders pages from both.
 */
export function sentAt(message: TranscriptMessage | undefined): string | null {
  return message?.timestamp ?? message?.created_at ?? null;
}

/** How each audit action reads, already in the reader's language. */
export type AuditLabeller = (action: string) => string;

/**
 * The transcript and the audit trail as one list, oldest first.
 *
 * Sorted by time, with rows that carry no time held in the order they arrived
 * rather than swept to one end: a message with a null timestamp is a data
 * defect, and burying it at the top of a conversation hides it. A stable sort
 * (which `Array.prototype.sort` is) keeps them beside the messages they were
 * delivered next to.
 */
export function replayMessages(
  messages: readonly TranscriptMessage[],
  audit: readonly SessionAuditEntry[],
  label: AuditLabeller,
): WidgetMessage[] {
  const rows: Array<{ at: number | null; message: WidgetMessage }> = [];

  messages.forEach((message) => {
    const at = sentAt(message);
    rows.push({
      at: at ? Date.parse(at) : null,
      message: {
        key: `m.${message.id}`,
        role: roleOf(message),
        text: message.content ?? message.message ?? '',
        at,
      },
    });
  });

  audit.forEach((entry, index) => {
    // No id on the wire, so the key is built from what the row does carry —
    // plus its position, always. Two transfers logged in the same second are
    // real, and keyed on action and time alone they collide and React drops
    // one of them. The index is stable for a given response, which is all a
    // list key has to be.
    rows.push({
      at: entry.created_at ? Date.parse(entry.created_at) : null,
      message: {
        key: `a.${index}.${entry.action}`,
        role: 'system',
        text: label(entry.action),
        at: entry.created_at,
      },
    });
  });

  return rows
    .map((row, index) => ({ ...row, index }))
    .sort((a, b) => {
      if (a.at === null || b.at === null || Number.isNaN(a.at) || Number.isNaN(b.at)) {
        return a.index - b.index;
      }
      return a.at - b.at || a.index - b.index;
    })
    .map((row) => row.message);
}
