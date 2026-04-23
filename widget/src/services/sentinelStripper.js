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

const MAX_SENTINEL_LEN = STREAM_SENTINELS.reduce((m, s) => Math.max(m, s.length), 0);

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
            // hold only that much back until more chunks arrive.
            const maxHold = Math.min(MAX_SENTINEL_LEN - 1, pending.length - lastBracket);
            let holdFrom = pending.length;
            for (let k = maxHold; k > 0; k--) {
                const tail = pending.slice(pending.length - k);
                // Only '[...' tails can be sentinel prefixes — anchor on the
                // bracket to avoid holding back text like "...]" that happens
                // to end near but after a '['.
                if (tail.startsWith('[') && STREAM_SENTINELS.some((s) => s.startsWith(tail))) {
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
