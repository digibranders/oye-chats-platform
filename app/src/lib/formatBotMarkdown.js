/**
 * formatBotMarkdown - ported VERBATIM from
 * `widget/src/components/MessageBubble.jsx` (the embeddable widget's bot
 * message renderer). The widget is the source of truth; if that
 * implementation changes, re-port it here so the Build Studio live preview
 * keeps rendering bot answers identically to the real chatbot. Do not
 * hand-edit this file's logic independently of the widget copy - only the
 * link-rendering helpers (SafeLink / icon-link / pill-CTA) and the
 * copy-to-plaintext helpers were intentionally left behind, since the
 * preview doesn't need them.
 */

// Follow-up questions (any capitalised sentence ending in "?") should render
// on their own paragraph, not glued to the previous sentence. Generic by
// design - matches ``_ensure_followup_spacing`` in rag_service.py so widget
// + backend share one rule. No opener whitelist to maintain as LLM phrasing
// drifts (Who / How / When / Where / Why / novel bridges all get handled).
//
// Sentence-boundary form: fires when a "?" sentence follows earlier
// punctuation and any whitespace (including a lone "\n" that markdown would
// otherwise collapse into a space).
const _FOLLOW_UP_REGEX = /([.!?])[ \t\n]+(?=[A-Z][^.!?\n]{2,200}\?)/g;

// Glued form: LLM emits "...add-onDo you need help?" with no gap.
//
// Correctly splitting the glued case without shredding CamelCase brand names
// (CleanSight, PayPalId, iPhone, eBay) requires knowing whether the capital
// letter after the lowercase actually starts a NEW sentence, or just a
// second part of a compound word. There's no purely-structural way to tell
// "CleanSight" from "onDo" - both are lowercase→uppercase with no space -
// so the regex uses the ONE signal that distinguishes them reliably in
// English: real follow-up questions almost always open with a small set of
// syntactically-required words (Wh-words + auxiliaries + a couple of
// pronouns). Compound brand names never open with those words.
//
// Guard clauses layered on top:
//   1. Question-opener whitelist (the ``(?:Would|Do|...)`` group) - the
//      capital MUST start a word from the whitelist. "Sight product…?"
//      doesn't match; "Do you need help?" does. Also catches the tricky
//      edge case "CleanSightWould you like a demo?" by splitting at the
//      correct t→W boundary instead of the wrong n→S one.
//   2. ``\b`` after the opener - stops "Would" from matching inside
//      "Wouldst" or "Wouldnt" (they'd be typos, but we don't want to
//      split inside them either).
//   3. ``[^.!?\n]{0,200}\?`` - bounds the tail so a stray "?" hundreds of
//      chars away doesn't drag an unrelated split into place.
//   4. Negative lookbehind for "://" within ~300 chars: skips matches that
//      land inside a URL. LLMs sometimes write YouTube markdown links
//      inline (video IDs like "92d9bzMUoI4" contain lowercase→uppercase
//      transitions); without this guard the URL gets shredded across
//      paragraphs and the link stops working.
//
// Novel opener drift is the deliberate trade-off: the previous whitelist-
// free version caught phrasings like "Anything else you need?" but at the
// cost of splitting every CamelCase brand name. The compound-word bug
// showed up in customer messages; a missed opener at worst leaves a
// follow-up question glued to the prior sentence, which is a cosmetic
// regression rather than a broken word. ``Any\w*`` covers the whole
// "Anything / Anyone / Anywhere / Anybody" family so we retain the most
// common novel opener anyway.
const _FOLLOW_UP_INLINE_REGEX =
    /(?<!:\/\/[^\s]{0,300})([a-z])(?=(?:Would|Could|Should|Do|Does|Did|Can|Will|Are|Is|Was|Were|Am|Have|Has|Had|May|Might|Must|Shall|What|Which|When|Where|Why|Who|How|Any\w*)\b[^.!?\n]{0,200}\?)/g;

// Markdown bullet/numbered list line.
const _LIST_ITEM_RE = /^[ \t]*(?:[-*+]|\d+[.)])\s+\S/;
const _LIST_PREFIX_RE = /^([ \t]*(?:[-*+]|\d+[.)])\s+)(.*)$/;

// Split a single bullet line whose body contains inline "- " separators back
// into multiple bullets. The LLM sometimes emits a list as one run-on line:
//   "- provenance- Continuous visibility- Pre-configured GitHub Actions"
// We split only when the dash follows a word/closing-bracket character and is
// followed by " " + a capital letter - that pattern is reliably an inline
// bullet boundary and won't fire on intra-word hyphens like "key-based" or
// "Multi-region".
const _splitInlineBullets = (line) => {
    const match = line.match(_LIST_PREFIX_RE);
    if (!match) return [line];
    const [, prefix, body] = match;
    const parts = body.split(/(?<=[a-z0-9)\]])-[ \t]+(?=[A-Z])/);
    if (parts.length === 1) return [line];
    return parts.map((p) => prefix + p.trim());
};

// Regex to find inline bullet boundaries inside a non-list paragraph.
// Matches a dash that is NOT preceded by whitespace (so it isn't a line-start
// marker) and IS followed by a capital letter - the reliable LLM pattern for
// run-on inline lists like "integration.- Custom Software- Application Dev…".
// Does NOT fire on intra-word hyphens ("User-friendly", "well-known") because
// those are followed by lowercase letters.
const _PARA_INLINE_BULLET_RE = /(?<!\s)-[ \t]+(?=[A-Z])/;

// Split a regular (non-list) paragraph that contains inline bullet separators
// into a proper intro + indented list. Returns null when no bullets detected.
const _splitParaInlineBullets = (line) => {
    if (!_PARA_INLINE_BULLET_RE.test(line)) return null;
    const parts = line.split(/(?<!\s)-[ \t]+(?=[A-Z])/);
    if (parts.length < 2) return null;
    const result = [];
    const intro = parts[0].trim();
    if (intro) { result.push(intro); result.push(''); }
    for (const part of parts.slice(1)) {
        if (part.trim()) result.push('- ' + part.trim());
    }
    return result;
};

// Reformat bot markdown so the LLM's terse "list + follow-up paragraph"
// output renders with clear separation:
//   1. Always insert a blank line between a list and a subsequent paragraph
//      (otherwise GFM treats the paragraph as lazy continuation of the last
//      bullet, gluing them together visually).
//   2. Break common follow-up offer phrases onto their own paragraph so
//      suggestions sit a blank line below the answer.
//
// Safe to run on partial streaming text - the rules only add whitespace,
// never remove content, so re-running over progressively longer strings
// produces the same result as running once on the final string.
export const formatBotMarkdown = (text) => {
    if (!text) return text;

    const rawLines = text.split('\n');
    const lines = [];
    for (const raw of rawLines) {
        if (_LIST_ITEM_RE.test(raw)) {
            for (const split of _splitInlineBullets(raw)) lines.push(split);
        } else {
            const paraSplit = _splitParaInlineBullets(raw);
            if (paraSplit) {
                for (const split of paraSplit) lines.push(split);
            } else {
                lines.push(raw);
            }
        }
    }
    const out = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        out.push(line);
        if (!_LIST_ITEM_RE.test(line)) continue;
        const next = lines[i + 1];
        if (next === undefined) continue;
        if (next.trim() === '') continue;
        if (_LIST_ITEM_RE.test(next)) continue;
        // Indented continuation of the bullet - leave alone.
        if (/^[ \t]+\S/.test(next) && !/^[ \t]*(?:[-*+]|\d+[.)])\s/.test(next)) continue;
        out.push('');
    }

    return out.join('\n')
        // Ensure a space before **Bold** when the LLM glues it directly after a
        // word: "communicationKey benefits:" → "communication **Key benefits:"
        // Only fires when a lowercase letter precedes ** and an uppercase follows,
        // so it won't touch closing ** or intra-word patterns like "re**start**".
        .replace(/([a-z])\*\*(?=[A-Z])/g, '$1 **')
        // Strip em-dashes from bot output. LLMs over-use them ("we offer SEO -
        // including technical, on-page, and content") and the brand prefers a
        // plain comma cadence. ``\s*-\s*`` collapses any surrounding whitespace
        // so the replacement reads as a single comma break, never as ", , ".
        // Runs before the follow-up paragraph rules so a question like "...we
        // offer SEO - which area interests you?" still gets the proper break
        // after em-dash normalisation. Only applied here in the bot renderer;
        // user-typed em-dashes are preserved.
        .replace(/\s*-\s*/g, ', ')
        .replace(_FOLLOW_UP_REGEX, '$1\n\n')
        .replace(_FOLLOW_UP_INLINE_REGEX, '$1\n\n');
};
