/**
 * Pure helpers lifted out of ChatWindow.jsx.
 *
 * ChatWindow is 4,658 lines with 65 pieces of state and 29 effects, and a
 * meaningful slice of it never touched either: regexes, formatters and
 * predicates that take their inputs as arguments and return a value. They sat
 * in the component's module purely because that is where they were written,
 * which made them invisible to the test runner (the widget has no DOM harness,
 * so nothing that lives in a .jsx component file can be unit-tested at all).
 *
 * Everything here is a verbatim move. Behaviour is unchanged.
 */

/**
 * Phrases the bot uses when it could not answer from the knowledge base.
 *
 * Two copies of this regex existed: this one, declared and never read, and a
 * narrower inline one inside `checkBotFallback` that required the word
 * "specific" in two of the four alternatives. The inline one is the one that
 * ran, so it is the one kept here. Widening it is a real behaviour change (it
 * decides when the widget offers a human) and belongs in its own commit.
 */
export const FALLBACK_PATTERNS =
    /don't have.*specific information|I'm not sure about that|couldn't find.*specific information|not contained in/i;

/** True when a bot reply is one of the "I could not find that" shapes. */
export const isBotFallback = (botText) => FALLBACK_PATTERNS.test(botText || '');

// Offline-form availability probe. Ten minutes of waiting for an operator to
// come online is generous; past that the visitor is writing a message, not
// waiting for a chat, and an unbounded probe is just load with no reader.
export const OFFLINE_POLL_INTERVAL_MS = 15000;
export const OFFLINE_POLL_MAX_TICKS = 40;

// How many turns into a conversation we keep re-reading the lead looking for a
// name the visitor typed in reply to the bot's "what should I call you?". The
// bot asks on its first reply, so the answer normally lands on turn 2; three
// attempts absorbs a visitor who ignores the question once and answers later,
// without polling forever for one who never answers at all.
export const NAME_PROBE_LIMIT = 3;

// Stable identifiers for system dividers. Several effects add and later remove
// the "connecting" divider; they used to find it by comparing `m.text` against
// an English string literal, which silently stopped matching the moment that
// copy was translated. Match on `systemId` instead, so the identity of a system
// message is independent of the language it is rendered in.
export const SYSTEM_MSG = {
    CONNECTING: 'connecting',
};

export const isSystemMessage = (m, systemId) => m.type === 'system' && m.systemId === systemId;

// Trailing sentences the bot's LLM tends to append when it thinks a handoff
// is imminent. If the quotation card is about to render, we strip this off
// the last bot message so the visitor doesn't see the invitation AND the
// quote card competing side-by-side. On Skip the stashed text is replayed
// as its own bot message so the follow-up still lands, just AFTER the
// quote decision.
export const HANDOFF_INVITATION_TAIL_RE =
    /\n?\s*(would you like (me )?to (connect|introduce|arrange)|shall i connect|should i connect|do you want me to connect|can i connect you|would you like to (chat|speak) with (our|the) team|would you like to talk to (our|the) team|would you like me to loop in (our|the) team|let me know if you'?d like me to (connect|introduce))[^.?!]*[.?!]?\s*$/i;

// Fallback: any trailing question the bot appends right before the quote card
// (e.g. "Want the implementation steps or the demo material?"). When the quote
// is about to render, that follow-up competes with the card, so we peel the
// last question sentence off the message. Matches only the final "…?" run —
// [^.!?\n]* stops at the previous sentence's terminator, so earlier sentences
// are kept. Like the handoff tail, the stripped text is stashed and replayed
// after the visitor decides on (or skips) the quote.
export const TRAILING_QUESTION_TAIL_RE = /\s*[^.!?\n]*\?\s*$/;

// Strip trailing orphaned markdown tokens that ReactMarkdown would render as
// raw text, e.g. a stream interrupted mid-bold: "Here is **important" → "Here is"
export const sanitizeMarkdown = (text) => {
    if (!text) return text;
    return text
        .replace(/\*{1,2}$/, '')
        .replace(/_+$/, '')
        .replace(/`+$/, '')
        .trim();
};

// Initials helper. Handles unicode names and empty values defensively.
export const getInitials = (name) => {
    if (!name) return '?';
    const parts = name.trim().split(/\s+/).filter(Boolean).slice(0, 2);
    if (parts.length === 0) return '?';
    return parts.map((part) => Array.from(part)[0] || '').join('').toUpperCase();
};

export const looksLikeEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

/**
 * "Just now" / "5m ago" / "3h ago" / "2d ago" for the conversation-history
 * drawer. `translate` is the i18n lookup, passed in so this stays pure and so
 * a caller can test it without a locale bundle.
 */
export const relativeTimeLabel = (ts, translate, now = Date.now()) => {
    if (!Number.isFinite(ts) || ts <= 0) return '';
    const diffMs = Math.max(0, now - ts);
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return translate('header.time_just_now') || 'Just now';
    if (mins < 60) return translate('header.time_minutes_ago', { count: mins }) || `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return translate('header.time_hours_ago', { count: hours }) || `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return translate('header.time_days_ago', { count: days }) || `${days}d ago`;
};
