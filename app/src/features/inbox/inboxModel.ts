import type { Tone } from '../../ui';
import type {
  ActiveChat,
  OperatorMessage,
  QualifiedSession,
  QueueItem,
} from './liveChatProtocol';
import type { OfflineMessage } from '../../types/domain';

/**
 * The inbox's one list, and the four scopes onto it.
 *
 * The surface this replaces split the same job across three tabs — "Messages",
 * "Live chat" and "Quick replies" — where the first two were the same question
 * asked of two data sources ("who needs a person?") and the third was
 * configuration filed under an inbox. Worse, the live tab then re-split itself
 * into three internal lists, so an operator was reading four lists across two
 * levels of tabbing to answer one question.
 *
 * Here there is a single list with a scope switcher, the way Intercom, LiveChat
 * and Front all settled on. A scope is a filter, not a different screen: rows
 * look the same, keyboard navigation is the same, and the selected conversation
 * survives a scope change if it is still visible.
 */

export type InboxView = 'waiting' | 'yours' | 'messages' | 'qualified';

/** The offline-message lifecycle, as the backend stores it. */
export type OfflineStatus = 'new' | 'read' | 'replied';

export const INBOX_VIEWS: readonly InboxView[] = ['waiting', 'yours', 'messages', 'qualified'];

export interface InboxViewMeta {
  value: InboxView;
  label: string;
  /** What this scope answers, for the list's empty state and the scope tooltip. */
  blurb: string;
  emptyTitle: string;
  emptyBody: string;
}

export const VIEW_META: Record<InboxView, InboxViewMeta> = {
  waiting: {
    value: 'waiting',
    label: 'Waiting',
    blurb: 'Visitors who have asked for a person and nobody has taken yet.',
    emptyTitle: 'Nobody is waiting',
    emptyBody:
      'When a visitor asks for a human — or the AI hands one over — they appear here with how long they have been waiting.',
  },
  yours: {
    value: 'yours',
    label: 'Yours',
    blurb: 'The conversations you have accepted and are answering now.',
    emptyTitle: 'You have no open chats',
    emptyBody: 'Accept someone from Waiting and the conversation moves here.',
  },
  messages: {
    value: 'messages',
    label: 'Messages',
    blurb: 'Left through the widget while no operator was available.',
    emptyTitle: 'No messages',
    emptyBody:
      'When a visitor writes to you outside your business hours, or with nobody online, the message lands here.',
  },
  qualified: {
    value: 'qualified',
    label: 'Qualified',
    blurb: 'Visitors the AI is still handling, ranked by how strong the lead looks.',
    emptyTitle: 'Nothing qualified yet',
    emptyBody:
      'As the AI learns a visitor’s budget, authority, need or timeline, the conversation surfaces here so you can step in before they leave.',
  },
};

/** What a row points at. Determines the centre pane and the actions on it. */
export type InboxKind = 'waiting' | 'live' | 'offline' | 'qualified';

/**
 * One row, whatever it came from.
 *
 * `id` is URL-safe and unique across kinds, because selection lives in the query
 * string: an offline message and a chat session can hold the same numeric id in
 * their own namespaces, and a bare id in the URL could select either.
 */
export interface InboxItem {
  id: string;
  kind: InboxKind;
  /** Chat kinds only. */
  sessionId: string | null;
  /** Offline messages only. */
  messageId: number | null;
  name: string;
  /** One line of context: the last thing said, or why they are waiting. */
  preview: string;
  /** ISO timestamp the row is sorted and timestamped by. */
  at: string | null;
  botName: string | null;
  /** Unread inbound messages, for the count on the row. */
  unread: number;
  /** A short state word, if the row has one worth carrying. */
  state: { label: string; tone: Tone } | null;
  /** Visitor is connected right now. Drives the presence dot. */
  online: boolean;
}

export function itemIdForSession(sessionId: string): string {
  return `s.${sessionId}`;
}

export function itemIdForMessage(messageId: number): string {
  return `m.${messageId}`;
}

/** The session id inside a row id, or null when the row is not a chat. */
export function sessionIdFromItemId(id: string | null | undefined): string | null {
  if (!id || !id.startsWith('s.')) return null;
  const rest = id.slice(2);
  return rest.length > 0 ? rest : null;
}

const BANT_TONE: Record<string, Tone> = {
  hot: 'danger',
  warm: 'warning',
  cool: 'neutral',
  qualified: 'success',
  unqualified: 'neutral',
};

/** Title-case a backend enum for display without inventing a label table. */
function humanise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).replace(/_/g, ' ');
}

export function toWaitingItem(entry: QueueItem): InboxItem {
  return {
    id: itemIdForSession(entry.session_id),
    kind: 'waiting',
    sessionId: entry.session_id,
    messageId: null,
    name: entry.name?.trim() || 'Visitor',
    preview: entry.reason?.trim() || 'Asked to speak to a person',
    at: entry.created_at ?? null,
    botName: entry.bot_name,
    unread: 0,
    state: null,
    online: true,
  };
}

export function toLiveItem(
  chat: ActiveChat,
  messages: OperatorMessage[] | undefined,
  unread: number,
  online: boolean,
  ended: { reason: 'closed' | 'transferred'; transferredTo: string | null } | undefined,
): InboxItem {
  const last = messages && messages.length > 0 ? messages[messages.length - 1] : undefined;
  return {
    id: itemIdForSession(chat.session_id),
    kind: 'live',
    sessionId: chat.session_id,
    messageId: null,
    name: chat.visitor_name?.trim() || 'Visitor',
    preview: last?.content?.trim() || chat.reason?.trim() || 'No messages yet',
    at: last?.timestamp ?? null,
    botName: chat.bot_name,
    unread,
    state: ended
      ? {
          label: ended.reason === 'transferred' ? 'Handed over' : 'Ended',
          tone: 'neutral',
        }
      : null,
    online,
  };
}

export function toOfflineItem(message: OfflineMessage): InboxItem {
  const status = (message.status ?? 'new').toLowerCase();
  return {
    id: itemIdForMessage(message.id),
    kind: 'offline',
    sessionId: null,
    messageId: message.id,
    name: message.visitor_name?.trim() || message.visitor_email?.trim() || 'Visitor',
    preview: message.message_body?.trim() || 'No message body',
    at: message.created_at ?? null,
    botName: message.bot_name ?? null,
    // An unread offline message is worth one unread, so the scope count means
    // "things you have not read" in both scopes rather than two different things.
    unread: status === 'new' ? 1 : 0,
    state:
      status === 'replied'
        ? { label: 'Replied', tone: 'success' }
        : status === 'read'
          ? { label: 'Read', tone: 'neutral' }
          : { label: 'New', tone: 'warning' },
    online: false,
  };
}

export function toQualifiedItem(session: QualifiedSession): InboxItem {
  const tier = (session.bant_tier || 'unqualified').toLowerCase();
  return {
    id: itemIdForSession(session.session_id),
    kind: 'qualified',
    sessionId: session.session_id,
    messageId: null,
    name: session.name?.trim() || 'Visitor',
    preview: session.last_message_preview?.trim() || 'No messages yet',
    at: session.last_message_at,
    botName: session.bot_name,
    unread: 0,
    state: { label: humanise(tier), tone: BANT_TONE[tier] ?? 'neutral' },
    online: false,
  };
}

/** Newest first, with rows that have no timestamp last rather than first. */
export function byRecency(a: InboxItem, b: InboxItem): number {
  const left = a.at ? Date.parse(a.at) : Number.NEGATIVE_INFINITY;
  const right = b.at ? Date.parse(b.at) : Number.NEGATIVE_INFINITY;
  return right - left;
}

/** Case-insensitive match across the two fields an operator actually scans. */
export function matchesQuery(item: InboxItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return (
    item.name.toLowerCase().includes(needle) ||
    item.preview.toLowerCase().includes(needle) ||
    (item.botName ?? '').toLowerCase().includes(needle)
  );
}

/**
 * How long a visitor has been waiting, as a word.
 *
 * Deliberately not the generic relative formatter: "5 minutes ago" describes the
 * past, and what the operator needs to read off a queue is a duration that is
 * still running. Above ten minutes it is also a problem, which the caller tones
 * accordingly.
 */
export function waitLabel(since: string | null, now: number): string {
  if (!since) return '';
  const started = Date.parse(since);
  if (Number.isNaN(started)) return '';
  const seconds = Math.max(0, Math.round((now - started) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d`;
}

/**
 * When a row last moved, in one or two characters.
 *
 * `formatRelative` renders "14 hours ago", and every row in a busy queue says
 * roughly the same thing at roughly the same length: about 90px of the ~200px a
 * 320px row has for its first line, spent on a phrase the operator scans rather
 * than reads. Behind a badge that is what truncated "Farid Haddad" to "Farid
 * Ha…". Intercom, Front and Slack all print `14h` here for the same reason.
 *
 * The full phrase is not lost — the caller carries it on the row's `title` and
 * in its accessible name, which is where a reader who wants the exact time
 * looks anyway.
 */
export function shortAgo(at: string | null, now: number): string {
  if (!at) return '';
  const then = Date.parse(at);
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.floor(days / 7);
  return weeks < 53 ? `${weeks}w` : `${Math.floor(days / 365)}y`;
}

/** Waiting longer than this is escalated in the list, not just counted. */
export const WAIT_ESCALATION_MS = 10 * 60 * 1000;

export function waitTone(since: string | null, now: number): Tone {
  if (!since) return 'neutral';
  const started = Date.parse(since);
  if (Number.isNaN(started)) return 'neutral';
  return now - started > WAIT_ESCALATION_MS ? 'danger' : 'warning';
}
