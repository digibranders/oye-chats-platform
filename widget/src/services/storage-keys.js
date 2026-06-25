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
