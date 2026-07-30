// Storage keys are namespaced per bot so a visitor who interacts with one
// OyeChats-powered site doesn't carry session state into another (different
// bot, possibly different customer) on the same browser. Before namespacing
// existed, a stale `chat_session_id` from bot A would silently suppress the
// pre-chat lead form on bot B because the widget thought the visitor was
// "returning".

const FALLBACK_BOT_KEY = 'default';

function currentBotKey() {
    if (typeof window === 'undefined') return FALLBACK_BOT_KEY;
    return window.OYECHATS_BOT_KEY || window.OYECHATS_API_KEY || FALLBACK_BOT_KEY;
}

export function getSessionKey(botKey) {
    return `chat_session_id_${botKey || currentBotKey()}`;
}

// ── Cross-subdomain session continuity ──────────────────────────────────────
// The session id normally lives in ``localStorage``, which the browser
// hard-partitions per origin — so a visitor moving from ``example.com`` to
// ``academy.example.com`` would start a fresh conversation. When the bot has
// ``session_share_domain`` configured (Admin → Channels), we ALSO mirror the id
// into a cookie scoped to that parent domain (``Domain=.example.com``), which a
// subdomain CAN read. localStorage stays the primary store (same-origin
// behaviour is unchanged); the cookie is the bridge that fills the gap.

const SESSION_COOKIE_PREFIX = 'oyechats_sid_';
// 30 days: long enough to bridge a multi-subdomain journey, short enough that a
// truly abandoned session eventually lapses.
const SESSION_COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

// Remember the last share domain a session was written under so explicit clears
// (New chat, shutdown) can expire the matching domain-scoped cookie even when
// the caller doesn't have the bot settings on hand.
let lastShareDomain = null;

function sessionCookieName(botKey) {
    return `${SESSION_COOKIE_PREFIX}${botKey || currentBotKey()}`;
}

// Turn a stored share domain into a cookie ``Domain`` value, or null when the
// host can't take one. ``example.com`` / ``.example.com`` → ``.example.com``.
// A bare single label (``localhost``) or an IP returns null: browsers reject a
// ``Domain`` attribute for those, so the caller writes a HOST-ONLY cookie
// instead. A host-only cookie ignores port, so two localhost origins on
// different ports — the standard local embed-test setup — still share it.
function toCookieDomain(shareDomain) {
    if (!shareDomain || typeof shareDomain !== 'string') return null;
    const host = shareDomain.trim().toLowerCase().replace(/^\.+/, '');
    if (!host) return null;
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return null; // IPv4 — no Domain cookie
    if (!host.includes('.')) return null; // localhost / single label — host-only
    return `.${host}`;
}

function readCookie(name) {
    if (typeof document === 'undefined' || !document.cookie) return null;
    const prefix = `${name}=`;
    for (const part of document.cookie.split(';')) {
        const c = part.trim();
        if (c.startsWith(prefix)) {
            const raw = c.slice(prefix.length);
            try { return decodeURIComponent(raw); } catch { return raw; }
        }
    }
    return null;
}

function writeCookie(name, value, cookieDomain) {
    if (typeof document === 'undefined') return;
    const secure = typeof location !== 'undefined' && location.protocol === 'https:' ? '; Secure' : '';
    let cookie = `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${SESSION_COOKIE_MAX_AGE}; SameSite=Lax${secure}`;
    if (cookieDomain) cookie += `; Domain=${cookieDomain}`;
    try { document.cookie = cookie; } catch { /* cookies disabled */ }
}

function expireCookie(name, cookieDomain) {
    if (typeof document === 'undefined') return;
    let cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax`;
    if (cookieDomain) cookie += `; Domain=${cookieDomain}`;
    try { document.cookie = cookie; } catch { /* cookies disabled */ }
}

// Resolve the persisted session id. localStorage wins so same-origin continuity
// is byte-for-byte what it was before this feature; the domain-scoped cookie is
// the fallback that carries the session across subdomains where localStorage
// can't reach. Reading a cookie needs no knowledge of its Domain, so this works
// on the subdomain before bot settings have loaded.
export function readSessionId(botKey) {
    try {
        const local = localStorage.getItem(getSessionKey(botKey));
        if (local) return local;
    } catch { /* storage disabled (private mode) */ }
    return readCookie(sessionCookieName(botKey));
}

// Persist the session id to localStorage, and — when the bot enables
// cross-subdomain sharing — mirror it into a parent-domain cookie.
export function writeSessionId(sessionId, { botKey, shareDomain } = {}) {
    if (!sessionId) return;
    try { localStorage.setItem(getSessionKey(botKey), sessionId); } catch { /* ignore */ }
    if (!shareDomain) return; // sharing off → localStorage only
    lastShareDomain = shareDomain;
    // ``toCookieDomain`` is null for hosts that can't take a Domain attribute
    // (localhost, IPs) — writeCookie then emits a host-only cookie, still shared
    // across ports for local multi-origin testing.
    writeCookie(sessionCookieName(botKey), sessionId, toCookieDomain(shareDomain));
}

// Forget the session everywhere: localStorage plus the shared cookie. The cookie
// is expired both host-only and parent-domain scoped, since the caller may not
// know which was set (we fall back to the last domain we wrote under).
export function clearSessionId({ botKey, shareDomain } = {}) {
    try { localStorage.removeItem(getSessionKey(botKey)); } catch { /* ignore */ }
    const name = sessionCookieName(botKey);
    expireCookie(name, null);
    const cookieDomain = toCookieDomain(shareDomain || lastShareDomain);
    if (cookieDomain) expireCookie(name, cookieDomain);
}

export function getLeadCapturedKey(botKey) {
    return `oyechats_lead_captured_${botKey || currentBotKey()}`;
}

// Re-ask the lead form after this many days even if the visitor previously
// submitted it. Long enough that a returning visitor inside the same month
// isn't pestered, short enough that a month-later return is treated as a
// fresh lead worth re-qualifying.
export const LEAD_CAPTURE_TTL_DAYS = 30;
const LEAD_CAPTURE_TTL_MS = LEAD_CAPTURE_TTL_DAYS * 24 * 60 * 60 * 1000;

// True when a stored capture timestamp is present and still within the TTL
// window. Tolerates the legacy `'true'` value (pre-TTL) by treating it as a
// fresh capture so existing users aren't immediately re-prompted on upgrade.
export function isLeadCaptureFresh(rawValue, now = Date.now()) {
    if (!rawValue) return false;
    if (rawValue === 'true') return true; // legacy marker, grandfather it in once
    const capturedAt = Number.parseInt(rawValue, 10);
    if (!Number.isFinite(capturedAt) || capturedAt <= 0) return false;
    return now - capturedAt < LEAD_CAPTURE_TTL_MS;
}

export function markLeadCaptured(storage = (typeof localStorage !== 'undefined' ? localStorage : null), botKey) {
    if (!storage) return;
    try {
        storage.setItem(getLeadCapturedKey(botKey), String(Date.now()));
    } catch {
        /* storage disabled (private mode, quota) — no-op */
    }
}

// Per-bot flag remembering that the visitor has opened the slash-command
// palette at least once this tab session. When present, ChatInput drops
// the "press / for commands" placeholder hint back to a plain "Write a
// message..." — repeat exposure after the visitor has clearly figured out
// the palette reads as nagging. Stored in ``sessionStorage`` (not
// ``localStorage``) so a return visit weeks later gets the hint again if
// they've forgotten, but a current session stops being lectured.
export function getSlashHintSeenKey(botKey) {
    return `oyechats_slash_hint_seen_${botKey || currentBotKey()}`;
}
