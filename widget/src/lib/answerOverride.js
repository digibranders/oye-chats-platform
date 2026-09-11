import { stripAllSentinels } from '../services/sentinelStripper.js';

/**
 * Show a streamed reply the server rewrote after part of it was already sent.
 *
 * The stream cannot recall bytes. When a guard on the server replaces an answer
 * mid-stream (a system-prompt leak, an output moderation hit, or a price figure
 * on a bot whose pricing goes to the team), only the persisted message holds the
 * replacement, and FINAL_METADATA carries it as `answer_override`. Without this
 * the bubble kept the fragment that had streamed ("It starts at ") glued to the
 * replacement, while the transcript showed something else.
 *
 * Replaces the text of the message with `targetId`, cleaned the way streamed
 * text is, keeping its id, cards and flags. Returns `messages` itself when the
 * frame carries no usable override, so a state update with it re-renders nothing.
 *
 * @param {Array<object>} messages
 * @param {string | number} targetId
 * @param {object | null | undefined} finalMeta
 * @returns {Array<object>}
 */
export const applyAnswerOverride = (messages, targetId, finalMeta) => {
    const raw = finalMeta?.answer_override;
    const text = typeof raw === 'string' ? stripAllSentinels(raw) : '';
    return text.trim() ? messages.map((msg) => (msg.id === targetId ? { ...msg, text } : msg)) : messages;
};
