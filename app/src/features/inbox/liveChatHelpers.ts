/**
 * liveChatHelpers - pure formatting/parsing utilities for the operator console.
 * No React, no side effects; safe to import anywhere.
 */

import type { ChatMessage } from '../../types/domain';
import { formatDate, formatTime } from '../../i18n/formatters';
import type { OperatorMessage, TranslationEntry } from './liveChatProtocol';
import { baseLanguage, directionForLocale as directionFor } from '../../services/localeCatalog';

const FILE_RE = /^\[File: (.+?)\]\((https?:\/\/[^\s)]+)\)$/;
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);

/** Only ever render http(s) file links - never `javascript:` or data URIs. */
export function isSafeFileUrl(url: string | undefined | null): url is string {
  if (!url) return false;
  return /^https?:\/\//i.test(url);
}

/** Two-letter initials for a visitor/operator avatar. */
export function initials(name: string | null | undefined): string {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return '?';
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Compact relative time: "now", "3m", "2h", "4d", else a short date. */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const diffMs = Date.now() - then;
  if (diffMs < 0) return 'now';
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return formatDate(new Date(then), { month: 'short', day: 'numeric', year: undefined });
}

/** Clock time (HH:MM) for message bubbles. */
export function clockTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  return formatTime(new Date(t), { hour: '2-digit', minute: '2-digit' });
}

let fileKeySeq = 0;

/**
 * Normalise a persisted `ChatMessage` (REST history) into the console's
 * `OperatorMessage` view model, decoding `[File: name](url)` markers into
 * renderable file attachments.
 */
export function parseHistoryMessage(m: ChatMessage): OperatorMessage {
  const content = m.content ?? m.message ?? '';
  const base: OperatorMessage = {
    key: m.id != null ? `srv-${m.id}` : `hist-${(fileKeySeq += 1)}`,
    dbId: typeof m.id === 'number' ? m.id : null,
    role: m.role,
    content,
    timestamp: m.created_at ?? null,
    // Carried through so a page refresh does not drop every translation. The
    // socket delivers these live, but history is what rebuilds the thread on
    // reload and on reconnect, so both paths must produce the same view model.
    sourceLanguage: m.source_language ?? null,
    translations: m.translations ?? undefined,
  };
  const match = content.match(FILE_RE);
  if (match && isSafeFileUrl(match[2])) {
    const filename = match[1];
    const ext = filename.split('.').pop()?.toLowerCase() ?? '';
    base.fileUrl = match[2];
    base.filename = filename;
    base.contentType = IMAGE_EXTS.has(ext)
      ? `image/${ext === 'jpg' ? 'jpeg' : ext}`
      : ext === 'pdf'
        ? 'application/pdf'
        : 'text/plain';
  }
  return base;
}

/**
 * How far apart an optimistic echo's clock and the server's `created_at` may
 * be and still be judged the same message. The echo is stamped in the browser
 * the instant the frame goes out; the row is stamped when the API writes it,
 * so the two differ by the round trip plus whatever clock skew the operator's
 * machine carries.
 */
const ECHO_MATCH_WINDOW_MS = 10_000;

/** True when a live entry is the operator's own optimistic echo of `persisted`. */
function isEchoOf(echo: OperatorMessage, persisted: OperatorMessage): boolean {
  if (echo.role !== persisted.role || echo.content !== persisted.content) return false;
  const echoAt = echo.timestamp ? Date.parse(echo.timestamp) : NaN;
  const persistedAt = persisted.timestamp ? Date.parse(persisted.timestamp) : NaN;
  // An echo with no usable clock on either side still matches on role and
  // content, which is enough: the alternative is rendering it twice.
  if (Number.isNaN(echoAt) || Number.isNaN(persistedAt)) return true;
  return Math.abs(echoAt - persistedAt) <= ECHO_MATCH_WINDOW_MS;
}

/**
 * Merge freshly-fetched REST history with any live WS messages already present
 * for a session. History (all DB-persisted) is the authoritative, ordered base;
 * live messages that arrived between accept and the history GET returning are
 * appended if not already represented.
 *
 * Persisted duplicates are deduped by `dbId`. An optimistic echo carries no
 * `dbId` - the backend routes operator messages to the visitor only and never
 * echoes them back - so it is deduped by role, content and a timestamp close to
 * the persisted row's. Without that, re-selecting a conversation (which remounts
 * the pane and reloads history) rendered every reply the operator had sent
 * twice, with the echo pinned below the rest of the thread.
 */
export function mergeHistoryWithLive(
  history: OperatorMessage[],
  live: OperatorMessage[] | undefined,
): OperatorMessage[] {
  if (!live || live.length === 0) return history;
  const knownDbIds = new Set<number>();
  for (const m of history) {
    if (m.dbId != null) knownDbIds.add(m.dbId);
  }
  // Each persisted row absorbs at most one echo, so two identical replies sent
  // in quick succession still render twice once both have been persisted.
  const claimed = new Set<OperatorMessage>();
  const extras = live.filter((m) => {
    if (m.dbId != null) return !knownDbIds.has(m.dbId);
    const match = history.find((h) => !claimed.has(h) && isEchoOf(m, h));
    if (!match) return true;
    claimed.add(match);
    return false;
  });
  return extras.length === 0 ? history : [...history, ...extras];
}

/**
 * Locale naming and direction come from the backend catalogue
 * (`services/localeCatalog`, filled by `GET /locales`), not from a table in
 * this file. Re-exported here so every existing caller keeps its import, and
 * so `resolveDisplay` below can use them directly.
 *
 * A component that RENDERS one of these names must also call
 * `useLocaleCatalog()`, otherwise it will not re-render when the catalogue
 * lands and will keep showing the uppercased-tag fallback.
 */
export {
  baseLanguage,
  directionForLocale as directionFor,
  labelForLanguage as languageLabel,
} from '../../services/localeCatalog';

/**
 * Decide what a message bubble should show.
 *
 * The original is always available and is what `content` holds. A translation
 * is shown only when one exists for the reader's language, succeeded, and the
 * message was not already written in that language. `showOriginal` (the
 * operator's per-message toggle) always wins.
 *
 * Returns the text plus the direction it must render in, because a translated
 * Arabic message inside an English conversation still needs `dir="rtl"`.
 */
export function resolveDisplay(
  message: OperatorMessage,
  readerLanguage: string | null | undefined,
  showOriginal: boolean,
): { text: string; language: string | null; isTranslated: boolean; direction: 'ltr' | 'rtl' } {
  const original = {
    text: message.content,
    language: message.sourceLanguage ?? null,
    isTranslated: false,
    direction: directionFor(message.sourceLanguage),
  };
  if (showOriginal) return original;

  const target = baseLanguage(readerLanguage);
  const source = baseLanguage(message.sourceLanguage);
  if (!target || !source || target === source) return original;

  const entry: TranslationEntry | undefined = message.translations?.[target];
  if (!entry || entry.status !== 'ok' || typeof entry.content !== 'string' || !entry.content) {
    return original;
  }
  return { text: entry.content, language: target, isTranslated: true, direction: directionFor(target) };
}

/**
 * True when a translation was expected for this reader but is not usable -
 * either it failed or it has not arrived yet. Drives the
 * "Translation unavailable" affordance and its retry.
 */
export function translationMissing(
  message: OperatorMessage,
  readerLanguage: string | null | undefined,
): boolean {
  const target = baseLanguage(readerLanguage);
  const source = baseLanguage(message.sourceLanguage);
  if (!target || !source || target === source) return false;
  const entry = message.translations?.[target];
  return !entry || entry.status !== 'ok' || !entry.content;
}

/** Highest DB id among the visitor's messages - the read-receipt high-water mark. */
export function maxVisitorDbId(messages: OperatorMessage[]): number {
  let max = 0;
  for (const m of messages) {
    if (m.role === 'user' && typeof m.dbId === 'number' && m.dbId > max) max = m.dbId;
  }
  return max;
}
