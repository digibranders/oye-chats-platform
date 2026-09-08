import type { ActiveChat, OperatorMessage, QueueItem } from '../features/inbox/liveChatProtocol';

/**
 * Who needs the operator's attention, and in what order.
 *
 * Pure, and separate from the card that draws it, because the rules here are
 * the ones that go wrong quietly. Two of them exist to protect a click rather
 * than to look tidy, and neither can be checked by looking at a screenshot:
 *
 * - **Arrivals append.** A new visitor never takes the top slot. An operator
 *   moving a pointer toward "Take it" must not have a different person slide
 *   under it on the way. This console has already shipped two defects in that
 *   family this week (a reflow swallowing a click on the auth pages, and
 *   `sr-only` extending a scroll container), so it is a rule here rather than
 *   an accident of ordering.
 * - **Dismissal is per visitor.** Closing one card must not close the queue.
 *   A global "hide alerts" would recreate the reported bug in a new place.
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
  /** When the wait started, ISO. Null when the payload carried no time. */
  since: string | null;
  /** First seen by THIS tab, so a card that arrives without a time still ages. */
  seenAt: number;
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

/** How long this alert has been waiting, at `now`. */
export function waitedMs(alert: LobbyAlert, now: number): number {
  const started = alert.since ? Date.parse(alert.since) : Number.NaN;
  // `seenAt` is the floor, not merely a fallback: a server clock a few seconds
  // ahead of the browser would otherwise produce a negative wait and a card
  // that reads "0s" for a minute.
  const from = Number.isFinite(started) ? Math.min(started, alert.seenAt) : alert.seenAt;
  return Math.max(0, now - from);
}

export interface LobbySources {
  queue: readonly QueueItem[];
  activeChats: Record<string, ActiveChat>;
  unreadBySession: Record<string, number>;
  messagesBySession: Record<string, OperatorMessage[]>;
  /** Session ids the operator has closed the card for, per visitor. */
  dismissed: ReadonlySet<string>;
  /**
   * The order sessions were first seen by this tab, oldest first.
   *
   * Held by the caller across renders. Without it "append" is not expressible:
   * the queue payload is a snapshot with no arrival order of its own, and
   * sorting by timestamp reorders the stack the moment a server clock disagrees
   * with a browser one.
   */
  arrivals: ReadonlyMap<string, number>;
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
  const { queue, activeChats, unreadBySession, messagesBySession, dismissed, arrivals } = sources;
  if (!sources.enabled || sources.onInboxPage) return [];

  const seen = (sessionId: string): number => arrivals.get(sessionId) ?? Number.MAX_SAFE_INTEGER;
  const byArrival = (a: LobbyAlert, b: LobbyAlert): number => seen(a.sessionId) - seen(b.sessionId);

  const waiting: LobbyAlert[] = queue
    .filter((entry) => !dismissed.has(entry.session_id))
    .map((entry) => ({
      key: `w.${entry.session_id}`,
      sessionId: entry.session_id,
      kind: 'waiting' as const,
      name: entry.name?.trim() || '',
      detail: entry.bot_name?.trim() || null,
      preview: firstLine(entry.reason),
      since: entry.created_at ?? null,
      seenAt: seen(entry.session_id),
    }))
    .sort(byArrival);

  const messages: LobbyAlert[] = Object.values(activeChats)
    .filter((chat) => (unreadBySession[chat.session_id] ?? 0) > 0)
    .filter((chat) => !dismissed.has(chat.session_id))
    .map((chat) => {
      const thread = messagesBySession[chat.session_id];
      const last = thread && thread.length > 0 ? thread[thread.length - 1] : undefined;
      return {
        key: `m.${chat.session_id}`,
        sessionId: chat.session_id,
        kind: 'message' as const,
        name: chat.visitor_name?.trim() || '',
        detail: chat.bot_name?.trim() || null,
        preview: firstLine(last?.content),
        // The wait that matters is since THEIR message, not since the chat
        // opened: a two-hour conversation is not a two-hour wait.
        since: last?.timestamp ?? null,
        seenAt: seen(chat.session_id),
      };
    })
    .sort(byArrival);

  return [...waiting, ...messages];
}

/**
 * Arrival order, carried forward.
 *
 * Returns the same Map when nothing changed, so a caller can hold it in a ref
 * and not re-render on every socket frame. Sessions that have left are dropped:
 * a visitor who gives up and comes back an hour later is a new arrival, and
 * keeping their old slot would file them above people who have waited longer.
 */
export function trackArrivals(
  previous: ReadonlyMap<string, number>,
  present: readonly string[],
  now: number,
): ReadonlyMap<string, number> {
  const live = new Set(present);
  let changed = previous.size !== live.size;
  const next = new Map<string, number>();
  for (const sessionId of present) {
    const existing = previous.get(sessionId);
    if (existing === undefined) changed = true;
    next.set(sessionId, existing ?? now);
  }
  if (!changed) {
    for (const sessionId of previous.keys()) {
      if (!live.has(sessionId)) {
        changed = true;
        break;
      }
    }
  }
  return changed ? next : previous;
}
