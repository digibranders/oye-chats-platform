import type { ActiveChat, OperatorMessage, QueueItem } from '../features/inbox/liveChatProtocol';

/**
 * Who needs the operator's attention, and in what order.
 *
 * Pure, and separate from the card that draws it, because the rules here are
 * the ones that go wrong quietly. Two of them exist to protect a click rather
 * than to look tidy, and neither can be checked by looking at a screenshot:
 *
 * - **Arrivals append.** A new visitor never takes the top slot, and no card
 *   ever swaps places with another while it is on screen. An operator moving a
 *   pointer toward "Take it" must not have a different person slide under it on
 *   the way. This console has already shipped two defects in that family this
 *   week (a reflow swallowing a click on the auth pages, and `sr-only`
 *   extending a scroll container), so it is a rule here rather than an accident
 *   of ordering.
 * - **Dismissal is per visitor.** Closing one card must not close the queue.
 *   A global "hide alerts" would recreate the reported bug in a new place.
 *
 * Ordering is by the server's own timestamps rather than by when this tab
 * happened to see each session. That is not a shortcut: the browser's clock may
 * be minutes off the server's, but two SERVER timestamps still order correctly
 * relative to each other, which is all a sort needs. Skew only distorts
 * durations, and `waitedMs` is where that is handled.
 */

/** How urgent a wait has become. Drives the card's stripe, never alone. */
export type LobbyBand = 'fresh' | 'ageing' | 'overdue';

/** A visitor who has asked for a person, or a message in a chat you hold. */
export type LobbyKind = 'waiting' | 'message';

export interface LobbyAlert {
  /** Stable across renders and across re-orderings. The session is the identity. */
  key: string;
  sessionId: string;
  kind: LobbyKind;
  name: string;
  /** Company, chatbot, or whatever context the payload actually carried. */
  detail: string | null;
  /** Their last message, or why they are waiting. */
  preview: string | null;
  /**
   * When the wait started, ISO, or null when the payload carried no time.
   *
   * Null is rendered as no timer at all rather than as "0s". A card that
   * invents a duration it does not know is worse than one that admits it: the
   * operator reads the number and decides who to answer first.
   */
  since: string | null;
  /**
   * Why they are in the queue: `handoff`, `transfer` or `operator_dropped`.
   *
   * An operator dropping their live chats re-queues them, which restarts the
   * clock. Rather than let the timer lie about it, the card says so in words:
   * this visitor has already been let down once, even though the wait it is
   * counting right now is short.
   */
  requeueReason: string | null;
}

/**
 * A visitor who has waited this long is about to give up.
 *
 * Chosen against the widget's own handoff copy rather than picked from the air:
 * it tells the visitor someone will be with them shortly, and three minutes is
 * past the point where that sentence is still true.
 */
export const OVERDUE_MS = 3 * 60_000;
/** Past a minute the wait has stopped being incidental. */
export const AGEING_MS = 60_000;

export function ageBand(waitedMs: number): LobbyBand {
  if (waitedMs >= OVERDUE_MS) return 'overdue';
  if (waitedMs >= AGEING_MS) return 'ageing';
  return 'fresh';
}

/** How long this alert has been waiting at `now`, or null when nobody knows. */
export function waitedMs(alert: LobbyAlert, now: number): number | null {
  const started = alert.since ? Date.parse(alert.since) : Number.NaN;
  if (!Number.isFinite(started)) return null;
  // Clamped at zero: a server clock a few seconds ahead of the browser would
  // otherwise produce a negative wait, and a card counting backwards.
  return Math.max(0, now - started);
}

export interface LobbySources {
  queue: readonly QueueItem[];
  activeChats: Record<string, ActiveChat>;
  unreadBySession: Record<string, number>;
  messagesBySession: Record<string, OperatorMessage[]>;
  /**
   * Cards the operator has closed, as `sessionId -> the `since` it applied to`.
   *
   * Keyed on the moment rather than the session because a widget session
   * survives in the visitor's browser: somebody who asks for a person, is
   * dismissed, gives up, and asks again ten minutes later comes back under the
   * SAME session id. A plain set of ids would swallow that second request in
   * silence, which is the reported bug wearing a different hat. A `since` that
   * no longer matches is a new request, and the card returns.
   */
  dismissed: ReadonlyMap<string, string | null>;
  /** Nothing is raised while off duty, or on the page that already shows it. */
  enabled: boolean;
  onInboxPage: boolean;
}

function firstLine(text: string | null | undefined): string | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  const line = trimmed.split('\n')[0];
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

/**
 * The cards to show, oldest arrival first.
 *
 * A lobby visitor always outranks a message in a chat the operator already
 * holds: nobody owns the first one, and they are the one who leaves.
 */
export function alertsFrom(sources: LobbySources): LobbyAlert[] {
  const { queue, activeChats, unreadBySession, messagesBySession, dismissed } = sources;
  if (!sources.enabled || sources.onInboxPage) return [];

  const at = (since: string | null): number => {
    const parsed = since ? Date.parse(since) : Number.NaN;
    // Undated last, not first: an unknown wait is not an infinite one, and
    // putting it on top would push somebody with a real, long wait down.
    return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
  };
  const oldestFirst = (a: LobbyAlert, b: LobbyAlert): number => at(a.since) - at(b.since);

  const waiting: LobbyAlert[] = queue
    // Keyed on the same field the sort reads. It used to key on `created_at`,
    // which the server never sent, so every dismissal keyed on null and a
    // visitor who was dismissed once could never raise a card again.
    .filter((entry) => dismissed.get(entry.session_id) !== (entry.waiting_since ?? null))
    .map((entry) => ({
      key: `w.${entry.session_id}`,
      sessionId: entry.session_id,
      kind: 'waiting' as const,
      name: entry.name?.trim() || '',
      detail: entry.bot_name?.trim() || null,
      preview: firstLine(entry.reason),
      since: entry.waiting_since ?? null,
      requeueReason: entry.requeue_reason ?? null,
    }))
    .sort(oldestFirst);

  const messages: LobbyAlert[] = Object.values(activeChats)
    .map((chat): LobbyAlert | null => {
      const unread = unreadBySession[chat.session_id] ?? 0;
      if (unread <= 0) return null;
      const thread = messagesBySession[chat.session_id] ?? [];
      const last = thread.length > 0 ? thread[thread.length - 1] : undefined;
      // The OLDEST unread, not the newest. "How long have they been waiting for
      // a reply" is the question, and it is also the only answer that does not
      // move: dating the card from their latest message would re-sort the stack
      // every time somebody typed another line, under whatever pointer was on
      // its way to a button.
      const firstUnread = thread.length >= unread ? thread[thread.length - unread] : thread[0];
      const since = firstUnread?.timestamp ?? null;
      if (dismissed.get(chat.session_id) === since) return null;
      return {
        key: `m.${chat.session_id}`,
        sessionId: chat.session_id,
        kind: 'message' as const,
        name: chat.visitor_name?.trim() || '',
        detail: chat.bot_name?.trim() || null,
        // The preview is the LATEST thing they said, which is what an operator
        // needs to decide; the timer is how long the first one has gone
        // unanswered. Different questions, different messages.
        preview: firstLine(last?.content),
        since,
        // A held chat is not a queue event; nobody re-queued this visitor.
        requeueReason: null,
      };
    })
    .filter((alert): alert is LobbyAlert => alert !== null)
    .sort(oldestFirst);

  return [...waiting, ...messages];
}

/** The wait as a word. Seconds matter here in a way they do not in a table. */
export function waitWords(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
