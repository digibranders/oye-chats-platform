// Conversation history + visitor-name memory, kept OUT of `storage-keys.js`.
//
// `storage-keys.js` is imported by `app-entry.jsx` (readLocalePreference) and
// `widget-controller.js` (clearSessionId), so it lands in the EAGER chunk that
// every visitor downloads on page view, including the ones who never open the
// chat. These helpers are only ever needed once ChatWindow is on screen, so
// they live here and ride the lazy chat chunk instead. Folding them back into
// storage-keys.js costs every page view ~240 B gzipped for nothing and breaks
// the app-entry size budget.

import { currentBotKey } from './storage-keys';

// ── Per-visitor session history index ───────────────────────────────────────
// The active session id (`storage-keys.js`) is a single value: starting a "New
// chat" replaces it, so the browser forgets every earlier conversation even
// though the rows still exist server-side. To let a visitor reopen a past
// conversation from the widget header, we keep a lightweight, per-bot INDEX of
// the sessions this browser has started: id + timestamps + a short preview of
// the first message.
//
// Privacy: the index lives only in this browser's localStorage. It is never
// sent anywhere and only ever references sessions THIS browser created, so it
// cannot leak one visitor's conversations to another (the public bot key alone
// must never enumerate sessions — that is why there is no server list endpoint).

// Cap the stored history so a long-lived visitor can't grow the index without
// bound. Oldest-touched entries fall off once the cap is exceeded.
export const MAX_SESSION_HISTORY = 20;
const SESSION_PREVIEW_MAX = 80;

export function getSessionIndexKey(botKey) {
    return `oyechats_sessions_${botKey || currentBotKey()}`;
}

// Read the session index as a newest-first array of
// `{ id, createdAt, updatedAt, preview }`. Malformed or missing storage yields
// an empty list rather than throwing, so callers can render unconditionally.
export function readSessionIndex(botKey) {
    try {
        if (typeof localStorage === 'undefined') return [];
        const raw = localStorage.getItem(getSessionIndexKey(botKey));
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed
            .filter((e) => e && typeof e.id === 'string' && e.id)
            .map((e) => ({
                id: e.id,
                createdAt: Number.isFinite(e.createdAt) ? e.createdAt : 0,
                updatedAt: Number.isFinite(e.updatedAt) ? e.updatedAt : (Number.isFinite(e.createdAt) ? e.createdAt : 0),
                preview: typeof e.preview === 'string' ? e.preview : '',
            }))
            .sort((a, b) => b.updatedAt - a.updatedAt);
    } catch {
        return [];
    }
}

function writeSessionIndex(entries, botKey) {
    try {
        if (typeof localStorage === 'undefined') return;
        const trimmed = entries
            .slice()
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, MAX_SESSION_HISTORY);
        localStorage.setItem(getSessionIndexKey(botKey), JSON.stringify(trimmed));
    } catch {
        /* storage disabled (private mode, quota), no-op */
    }
}

// Upsert a session into the index. First write stamps `createdAt`; every write
// bumps `updatedAt` so the most recently used conversation sorts to the top.
// `preview` is only set once (the first user message), so later touches don't
// overwrite a meaningful label with a blank.
export function recordSession(sessionId, { preview, botKey, now = Date.now() } = {}) {
    if (!sessionId || typeof sessionId !== 'string') return;
    const list = readSessionIndex(botKey);
    const existing = list.find((e) => e.id === sessionId);
    const cleanPreview = typeof preview === 'string'
        ? preview.trim().replace(/\s+/g, ' ').slice(0, SESSION_PREVIEW_MAX)
        : '';
    if (existing) {
        existing.updatedAt = now;
        if (cleanPreview && !existing.preview) existing.preview = cleanPreview;
    } else {
        list.push({ id: sessionId, createdAt: now, updatedAt: now, preview: cleanPreview });
    }
    writeSessionIndex(list, botKey);
}

// Drop a single conversation from the index (visitor "delete" in the menu).
export function removeSessionFromIndex(sessionId, botKey) {
    if (!sessionId) return;
    writeSessionIndex(readSessionIndex(botKey).filter((e) => e.id !== sessionId), botKey);
}

// ── Visitor name memory (across conversations) ──────────────────────────────
// The backend's "what should I call you?" gate is SESSION-scoped: `LeadInfo` is
// unique per session_id, so every new conversation starts with no name and the
// bot asks again. That was invisible while a visitor had one long-running
// session; it is not, now that starting a new chat is a first-class action.
//
// We remember the name per bot in this browser and re-seed it into each new
// session, so a returning visitor is greeted by name instead of re-interrogated.
// Deliberately its own key, NOT part of the conversation index: deleting a
// conversation from the history drawer must not make the bot forget who it is
// talking to.
//
// Same 30-day TTL as the lead-capture gate in `storage-keys.js`, for the same
// reason: a visitor returning a month later is treated as fresh. The TTL also
// bounds the shared-device case, where one visitor's name would otherwise
// greet the next person on that browser indefinitely.
export const VISITOR_NAME_TTL_DAYS = 30;
const VISITOR_NAME_TTL_MS = VISITOR_NAME_TTL_DAYS * 24 * 60 * 60 * 1000;
const VISITOR_NAME_MAX = 80;

export function getVisitorNameKey(botKey) {
    return `oyechats_visitor_name_${botKey || currentBotKey()}`;
}

/** The remembered name for this bot, or null when absent, malformed or expired. */
export function readVisitorName(botKey, now = Date.now()) {
    try {
        if (typeof localStorage === 'undefined') return null;
        const raw = localStorage.getItem(getVisitorNameKey(botKey));
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        const name = typeof parsed?.name === 'string' ? parsed.name.trim() : '';
        const savedAt = Number.isFinite(parsed?.savedAt) ? parsed.savedAt : 0;
        if (!name || savedAt <= 0) return null;
        if (now - savedAt >= VISITOR_NAME_TTL_MS) {
            // Expired. Drop it so the next read is a cheap miss.
            try { localStorage.removeItem(getVisitorNameKey(botKey)); } catch { /* ignore */ }
            return null;
        }
        return name;
    } catch {
        return null;
    }
}

/** Persist the visitor's name, refreshing the TTL window. No-op for a blank name. */
export function writeVisitorName(name, botKey, now = Date.now()) {
    if (!name || typeof name !== 'string') return;
    const clean = name.trim().replace(/\s+/g, ' ').slice(0, VISITOR_NAME_MAX);
    if (!clean) return;
    try {
        if (typeof localStorage === 'undefined') return;
        localStorage.setItem(getVisitorNameKey(botKey), JSON.stringify({ name: clean, savedAt: now }));
    } catch {
        /* storage disabled (private mode, quota), no-op */
    }
}

export function clearVisitorName(botKey) {
    try {
        if (typeof localStorage === 'undefined') return;
        localStorage.removeItem(getVisitorNameKey(botKey));
    } catch {
        /* no-op */
    }
}