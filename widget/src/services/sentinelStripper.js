/**
 * Streaming sentinel stripper.
 *
 * The RAG prompt instructs the LLM to emit sentinels such as
 * [MEETING_CARD] or [LEAVE_MESSAGE_CARD] on their own line to trigger
 * inline UI cards. The backend strips these from the persisted
 * ChatMessage and sets flags in FINAL_METADATA, but during streaming
 * each chunk is yielded as it arrives — so without client-side
 * scrubbing the raw token briefly flashes in the chat bubble.
 *
 * This module sits between the stream reader and the UI so that the
 * visitor never sees a stray token, even when the token straddles a
 * chunk boundary (e.g. chunk 1 ends with "[LEAVE_ME", chunk 2 starts
 * with "SSAGE_CARD]").
 *
 * Design notes:
 *  - Split-chunk safe: only holds back a trailing substring that could
 *    be the prefix of a known sentinel, and only when that substring
 *    actually starts with '[' (the sentinel marker). This prevents the
 *    UX regression where every chunk would buffer up to 19 chars —
 *    now the stripper is effectively a no-op for normal text.
 *  - Pure function factory: one stripper instance per stream, no
 *    shared state between concurrent chats.
 *  - Literal string matching (split+join) rather than regex — avoids
 *    regex-escape pitfalls if a sentinel ever contains special chars.
 */

export const STREAM_SENTINELS = Object.freeze([
    '[LEAVE_MESSAGE_CARD]',
    '[MEETING_CARD]',
]);

// Dynamic sentinels with a fixed prefix and a variable inner value (e.g.
// [CTA:timeline]). The backend emits one per qualifying question and only
// strips it from the persisted answer after the stream closes, so the widget
// must scrub it in-flight or the marker briefly appears in the bubble.
const CTA_PREFIX = '[CTA:';
const CTA_PATTERN = /\[CTA:[a-zA-Z0-9_]+\]/g;

// Media card sentinels — same pattern as CTA but with a different body
// grammar. [YOUTUBE_CARD:VIDEO_ID] where VIDEO_ID is the 11-char URL-safe
// alphabet; [DOWNLOAD_CARD:URL|FILENAME] where URL is a bracket/pipe/
// whitespace-free segment and FILENAME is anything up to a closing bracket.
// The visitor never sees a card sentinel — the widget renders the card via
// FINAL_METADATA instead — so in-flight stripping keeps the raw token from
// briefly typing into the bubble as the stream arrives token by token.
const YOUTUBE_CARD_PREFIX = '[YOUTUBE_CARD:';
const YOUTUBE_CARD_PATTERN = /\[YOUTUBE_CARD:[A-Za-z0-9_-]{11}\]/g;
const DOWNLOAD_CARD_PREFIX = '[DOWNLOAD_CARD:';
const DOWNLOAD_CARD_PATTERN = /\[DOWNLOAD_CARD:[^\s|\]]{1,500}\|[^\]\n]{1,200}\]/g;

// LLM keeps inventing new square-bracket placeholder phrasings —
// "[YouTube card below]", "[Video preview here]", "[Card: video]",
// "[See attached]", "[TBD]", etc. A keyword blocklist loses that game.
//
// General rule: by the time this pattern runs in stripAllSentinels, we
// have ALREADY stripped every valid sentinel this codebase emits (the
// four passes above: STREAM_SENTINELS, CTA, YOUTUBE_CARD, DOWNLOAD_CARD).
// So anything left inside [...] is either:
//   (a) a markdown link label — [Learn more](https://...) — where "("
//       immediately follows the closing bracket. MUST be preserved.
//   (b) LLM-invented placeholder prose. MUST be stripped.
//
// The negative lookahead (?!\() distinguishes the two. No keyword list
// to maintain — every new placeholder the LLM invents falls under the
// same rule automatically.
const LLM_LEAKED_BRACKET_PATTERN = /\[[^\]\n]{1,300}\](?!\()/g;

const MAX_SENTINEL_LEN = STREAM_SENTINELS.reduce((m, s) => Math.max(m, s.length), 0);

/**
 * Return true if `tail` could still grow into a complete [CTA:dimension] marker.
 * Covers both the fixed-prefix build-up ("[", "[C", "[CT", "[CTA", "[CTA:")
 * and the open dimension body ("[CTA:t", "[CTA:tim", ...) before the closing
 * ']' arrives in a later chunk.
 */
const couldBeCtaPrefix = (tail) => {
    if (!tail.startsWith('[')) return false;
    if (CTA_PREFIX.startsWith(tail)) return true;
    if (!tail.startsWith(CTA_PREFIX)) return false;
    const body = tail.slice(CTA_PREFIX.length);
    // Still building the dimension name (or just hit ':') and no ']' yet.
    return /^[a-zA-Z0-9_]*$/.test(body);
};

/**
 * Return true if `tail` could still grow into a complete [YOUTUBE_CARD:id]
 * marker. Mirrors couldBeCtaPrefix: prefix build-up OR open body with a
 * legal (partial) 11-char video ID and no closing bracket yet.
 */
const couldBeYoutubeCardPrefix = (tail) => {
    if (!tail.startsWith('[')) return false;
    if (YOUTUBE_CARD_PREFIX.startsWith(tail)) return true;
    if (!tail.startsWith(YOUTUBE_CARD_PREFIX)) return false;
    const body = tail.slice(YOUTUBE_CARD_PREFIX.length);
    // Video ID chars only, up to 11; no ']' yet.
    return /^[A-Za-z0-9_-]{0,11}$/.test(body);
};

/**
 * Return true if `tail` could still grow into a complete
 * [DOWNLOAD_CARD:URL|NAME] marker. URL segment cannot contain whitespace,
 * pipe, or closing bracket; once a pipe appears, the filename segment may
 * contain anything except newline / closing bracket.
 */
const couldBeDownloadCardPrefix = (tail) => {
    if (!tail.startsWith('[')) return false;
    if (DOWNLOAD_CARD_PREFIX.startsWith(tail)) return true;
    if (!tail.startsWith(DOWNLOAD_CARD_PREFIX)) return false;
    const body = tail.slice(DOWNLOAD_CARD_PREFIX.length);
    const pipeIdx = body.indexOf('|');
    if (pipeIdx === -1) {
        // URL segment still building.
        return /^[^\s|\]]*$/.test(body);
    }
    const namePart = body.slice(pipeIdx + 1);
    // Name segment still building — anything except newline / closing bracket.
    return !/[\]\n]/.test(namePart);
};

/**
 * Remove every complete occurrence of any sentinel from `text`.
 * @param {string} text
 * @returns {string}
 */
export const stripAllSentinels = (text) => {
    if (!text) return '';
    let out = text;
    for (const s of STREAM_SENTINELS) {
        if (out.includes(s)) out = out.split(s).join('');
    }
    if (out.includes(CTA_PREFIX)) out = out.replace(CTA_PATTERN, '');
    if (out.includes(YOUTUBE_CARD_PREFIX)) out = out.replace(YOUTUBE_CARD_PATTERN, '');
    if (out.includes(DOWNLOAD_CARD_PREFIX)) out = out.replace(DOWNLOAD_CARD_PATTERN, '');
    // General bracket sweep — any [...] not followed by ( is either a
    // valid sentinel we've already stripped above, or an LLM-invented
    // placeholder we should strip. The ``includes('[')`` guard skips
    // the regex entirely for normal text (hot path).
    if (out.includes('[')) out = out.replace(LLM_LEAKED_BRACKET_PATTERN, '');
    return out;
};

/**
 * Create a stateful stripper for a single stream.
 *
 * Usage:
 *   const s = createSentinelStripper();
 *   onChunk(s.push(chunk));      // during the stream
 *   onChunk(s.flush());          // at stream end (or before FINAL_METADATA)
 *
 * @returns {{ push: (chunk: string) => string, flush: () => string }}
 */
export const createSentinelStripper = () => {
    let pending = '';

    return {
        /** Absorb a new chunk; return only the text safe to render right now. */
        push(chunk) {
            if (!chunk) return '';
            pending = stripAllSentinels(pending + chunk);

            // Fast path: if the pending buffer does not contain the sentinel
            // marker character, no sentinel can possibly start inside it.
            // Release everything — zero trailing-char latency for normal text.
            const lastBracket = pending.lastIndexOf('[');
            if (lastBracket === -1) {
                const emit = pending;
                pending = '';
                return emit;
            }

            // A '[' is present in the tail. Identify the longest trailing
            // substring that could still be the prefix of a known sentinel —
            // hold only that much back until more chunks arrive. The hold
            // window must cover the longest possible dynamic sentinel body:
            // [DOWNLOAD_CARD:URL|NAME] can be up to ~700 chars (500 URL + 200
            // name + wrapper). Clamp at 720 so a malformed unterminated token
            // can't pin arbitrary trailing text in `pending` forever.
            const maxHold = Math.min(
                Math.max(MAX_SENTINEL_LEN - 1, 720),
                pending.length - lastBracket,
            );
            let holdFrom = pending.length;
            for (let k = maxHold; k > 0; k--) {
                const tail = pending.slice(pending.length - k);
                // Only '[...' tails can be sentinel prefixes — anchor on the
                // bracket to avoid holding back text like "...]" that happens
                // to end near but after a '['.
                if (
                    tail.startsWith('[') &&
                    (STREAM_SENTINELS.some((s) => s.startsWith(tail)) ||
                        couldBeCtaPrefix(tail) ||
                        couldBeYoutubeCardPrefix(tail) ||
                        couldBeDownloadCardPrefix(tail))
                ) {
                    holdFrom = pending.length - k;
                    break;
                }
            }
            const emit = pending.slice(0, holdFrom);
            pending = pending.slice(holdFrom);
            return emit;
        },

        /** Stream is done — release everything still held, minus any completed sentinel. */
        flush() {
            const out = stripAllSentinels(pending);
            pending = '';
            return out;
        },
    };
};
