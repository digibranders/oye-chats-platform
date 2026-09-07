/**
 * Split a bot reply into its answer and its trailing follow-up question.
 *
 * The bot frequently closes a reply by asking the visitor something back (a
 * qualification probe, or a "which of these would you like?"). That sentence is
 * the bot ASKING rather than answering, and the UI marks the difference by
 * setting it in italics and, on a media-card turn, moving it below the card so
 * it is never sandwiched above the attachment.
 *
 * Lives here rather than in the component because this is the only part of that
 * behaviour with edges worth testing, and the widget's test runner covers
 * `lib/` but not `.jsx`.
 *
 * Operates on text ALREADY passed through `formatBotMarkdown`, which is what
 * breaks the follow-up onto its own paragraph. Splitting raw model output would
 * usually find no blank line to key off, because the model tends to glue the
 * question onto the preceding sentence.
 */

/**
 * @param {string} text reply text, already formatted by `formatBotMarkdown`
 * @returns {{body: string, followUp: string}} `followUp` is '' when the reply
 *   does not end in a question, in which case `body` is the text unchanged.
 */
export const splitTrailingFollowUp = (text) => {
    const src = (text || '').trimEnd();
    const idx = src.lastIndexOf('\n\n');
    if (idx === -1) return { body: text, followUp: '' };
    const tail = src.slice(idx + 2).trim();
    // Every clause earns its place:
    //  - ends with "?"   : it is a question, not a closing remark.
    //  - no newline      : a multi-line tail is a list or a paragraph that
    //                      happens to end in a question, not a one-line probe.
    //  - <= 160 chars    : a long final paragraph is part of the answer.
    //  - no list/quote/heading marker: those are structure, not a question.
    const isFollowUp =
        tail.endsWith('?') &&
        !tail.includes('\n') &&
        tail.length <= 160 &&
        !/^[-*+>#]|^\d+[.)]/.test(tail);
    if (!isFollowUp) return { body: text, followUp: '' };
    return { body: src.slice(0, idx).trimEnd(), followUp: tail };
};
