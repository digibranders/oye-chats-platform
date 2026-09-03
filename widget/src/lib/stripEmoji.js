/**
 * Remove pictographic characters (emoji) from a string, leaving every other
 * character untouched.
 *
 * Why not `\p{Emoji}`: that property matches ASCII digits, `#` and `*`, because
 * those are the bases of the keycap sequences (`1️⃣`, `#️⃣`). Stripping it
 * turned the welcome title "Welcome to 3M #1" into "Welcome to M " — a
 * customer's brand name silently mangled. `\p{Extended_Pictographic}` covers
 * the actual pictographs without the ASCII bases.
 *
 * The trailing cleanup removes the joiners and presentation selectors that are
 * left behind once the pictographs they bind are gone (ZWJ, VS15/VS16, the
 * keycap combining mark and the regional-indicator flag halves), then collapses
 * the whitespace the removal opened up.
 */
export const stripEmoji = (text) => {
    if (!text || typeof text !== 'string') return text;
    return text
        .replace(/\p{Extended_Pictographic}/gu, '')
        .replace(/\u200D|\uFE0E|\uFE0F|\u20E3/g, '')
        .replace(/\p{Regional_Indicator}/gu, '')
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
};

export default stripEmoji;
