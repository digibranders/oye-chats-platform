/**
 * liveChatHelpers - pure formatting/parsing utilities for the operator console.
 * No React, no side effects; safe to import anywhere.
 */

import type { ChatMessage } from '../../types/domain';
import type { OperatorMessage } from './liveChatProtocol';

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
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Clock time (HH:MM) for message bubbles. */
export function clockTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  return new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
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
 * Merge freshly-fetched REST history with any live WS messages already present
 * for a session. History (all DB-persisted) is the authoritative, ordered base;
 * live messages that arrived between accept and the history GET returning are
 * appended if not already represented. Persisted duplicates are deduped by
 * `dbId`; optimistic echoes (no `dbId`, e.g. the operator's own sends) are kept.
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
  const extras = live.filter((m) => m.dbId == null || !knownDbIds.has(m.dbId));
  return extras.length === 0 ? history : [...history, ...extras];
}

/** Highest DB id among the visitor's messages - the read-receipt high-water mark. */
export function maxVisitorDbId(messages: OperatorMessage[]): number {
  let max = 0;
  for (const m of messages) {
    if (m.role === 'user' && typeof m.dbId === 'number' && m.dbId > max) max = m.dbId;
  }
  return max;
}
