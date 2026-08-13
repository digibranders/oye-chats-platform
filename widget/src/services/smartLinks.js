/**
 * smartLinks - tracks which admin-configured "smart links" the visitor has
 * already clicked, so the widget can stop re-linking them for the rest of the
 * conversation. After a smart link is clicked once, the same keyword renders as
 * plain text in every later answer (the visitor has already been there).
 *
 * A module singleton rather than React state: the link renderer (`SafeLink` in
 * MessageBubble) is a module-level component shared across every message, so it
 * consults this registry directly at render time instead of threading props
 * through ReactMarkdown.
 *
 * Scope: smart links ONLY (matched by destination URL against the bot's
 * configured `smart_link_urls`). Service icon links and generic reference links
 * the bot writes are never affected.
 *
 * Persistence: one localStorage entry per bot, tagged with the active session id
 * so a brand-new conversation starts fresh while a page reload mid-conversation
 * keeps the suppression. Falls back to in-memory only when storage is blocked.
 */

/** Normalized set of the bot's smart-link destinations (URL only). */
let smartLinkUrls = new Set();
/** Normalized destinations the visitor has clicked in the active session. */
let clickedUrls = new Set();
/** Session id the current `clickedUrls` belongs to. */
let currentSessionId = null;

function storageKey() {
    const botKey = (typeof window !== 'undefined' && window.OYECHATS_BOT_KEY) || 'default';
    return `oyechats_smartlink_clicks_${botKey}`;
}

/**
 * Canonicalize a URL for comparison: trim, drop a trailing slash, lowercase.
 * The bot is instructed to emit the exact configured URL, so this only smooths
 * over cosmetic differences (a stray trailing slash, casing) rather than doing
 * real URL parsing.
 */
function normalizeUrl(href) {
    if (typeof href !== 'string') return '';
    const trimmed = href.trim();
    if (!trimmed) return '';
    return trimmed.replace(/\/+$/, '').toLowerCase();
}

function loadClicked() {
    clickedUrls = new Set();
    try {
        const raw = window.localStorage.getItem(storageKey());
        if (!raw) return;
        const parsed = JSON.parse(raw);
        // Only adopt the stored clicks when they belong to THIS conversation;
        // a new session id means a fresh start.
        if (parsed && parsed.sessionId === currentSessionId && Array.isArray(parsed.urls)) {
            parsed.urls.forEach((u) => {
                if (typeof u === 'string') clickedUrls.add(u);
            });
        }
    } catch {
        // localStorage unavailable (private mode / blocked) - in-memory only.
    }
}

function persistClicked() {
    try {
        window.localStorage.setItem(
            storageKey(),
            JSON.stringify({ sessionId: currentSessionId, urls: [...clickedUrls] }),
        );
    } catch {
        // Ignore write failures - suppression still works in-memory this session.
    }
}

/** Register the bot's smart-link destinations (from `settings.smart_link_urls`). */
export function setSmartLinkUrls(urls) {
    smartLinkUrls = new Set();
    if (Array.isArray(urls)) {
        urls.forEach((u) => {
            const n = normalizeUrl(u);
            if (n) smartLinkUrls.add(n);
        });
    }
}

/**
 * Point the registry at the active conversation. Loads that session's stored
 * clicks, or starts empty when the session changed (e.g. "New chat").
 */
export function setSmartLinkSession(sessionId) {
    const next = sessionId || null;
    if (next === currentSessionId) return;
    currentSessionId = next;
    loadClicked();
}

/** True when `href` is one of the bot's configured smart-link destinations. */
export function isSmartLink(href) {
    return smartLinkUrls.size > 0 && smartLinkUrls.has(normalizeUrl(href));
}

/** True when this smart link was already clicked in the active conversation. */
export function isSmartLinkClicked(href) {
    return clickedUrls.has(normalizeUrl(href));
}

/** Record a smart-link click so it stops being rendered as a link. */
export function markSmartLinkClicked(href) {
    const n = normalizeUrl(href);
    if (!n || clickedUrls.has(n)) return;
    clickedUrls.add(n);
    persistClicked();
}
