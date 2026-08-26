/**
 * Bot markdown normaliser.
 *
 * Reformats the LLM's terse markdown so ReactMarkdown (CommonMark, no
 * remark-gfm) renders it the way a human reads it. The model frequently:
 *   - emits a whole list as one run-on line ("- A- B- C"),
 *   - glues a follow-up question onto the previous sentence/bullet,
 *   - over-uses em-dashes.
 *
 * These are pure string transforms (no React/JSX), extracted from
 * MessageBubble.jsx so they can be unit-tested under `node --test` and so the
 * component keeps only presentation concerns. See botMarkdown.test.js.
 *
 * Safe to run on partial streaming text. Every rule only adds whitespace or
 * normalises separators, never removes content, so re-running over a
 * progressively longer string yields the same result as running once on the
 * final string.
 */

// Follow-up questions (any capitalised sentence ending in "?") should render
// on their own paragraph, not glued to the previous sentence. Generic by
// design. Matches ``_ensure_followup_spacing`` in rag_service.py so widget
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
// "CleanSight" from "onDo" (both are lowercase→uppercase with no space)
// so the regex uses the ONE signal that distinguishes them reliably in
// English: real follow-up questions almost always open with a small set of
// syntactically-required words (Wh-words + auxiliaries + a couple of
// pronouns). Compound brand names never open with those words.
//
// Guard clauses layered on top:
//   1. Question-opener whitelist (the ``(?:Would|Do|...)`` group), the
//      capital MUST start a word from the whitelist. "Sight product…?"
//      doesn't match; "Do you need help?" does. Also catches the tricky
//      edge case "CleanSightWould you like a demo?" by splitting at the
//      correct t→W boundary instead of the wrong n→S one.
//   2. ``\b`` after the opener. Stops "Would" from matching inside
//      "Wouldst" or "Wouldnt" (they'd be typos, but we don't want to
//      split inside them either).
//   3. ``[^.!?\n]{0,200}\?``. Bounds the tail so a stray "?" hundreds of
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

// Punctuation glued directly to a follow-up opener with NO gap: the LLM wrote
// "...be fast.What matters most…?" — a sentence-ending ``.``/``!``/``?``
// immediately followed by a question opener. This slips through BOTH regexes
// above: ``_FOLLOW_UP_REGEX`` requires whitespace after the punctuation, and
// ``_FOLLOW_UP_INLINE_REGEX`` requires a lowercase letter (not punctuation)
// right before the opener. Same opener whitelist + trailing ``?`` guard so
// brand names and abbreviations never split, and the ``://`` lookbehind keeps
// it out of URLs.
const _FOLLOW_UP_PUNCT_GLUE_REGEX =
    /(?<!:\/\/[^\s]{0,300})([.!?])(?=(?:Would|Could|Should|Do|Does|Did|Can|Will|Are|Is|Was|Were|Am|Have|Has|Had|May|Might|Must|Shall|What|Which|When|Where|Why|Who|How|Any\w*)\b[^.!?\n]{0,200}\?)/g;

// Markdown bullet/numbered list line.
const _LIST_ITEM_RE = /^[ \t]*(?:[-*+]|\d+[.)])\s+\S/;
const _LIST_PREFIX_RE = /^([ \t]*(?:[-*+]|\d+[.)])\s+)(.*)$/;

// Inline-bullet boundary: a dash that separates two run-on list items, e.g.
// the LLM's "...launcher- **Advanced**: system prompt..." Requires the dash to
// be followed by whitespace and then a capital letter, OPTIONALLY preceded by
// a markdown emphasis marker (``**``/``*``/``_``/`` ` ``). The emphasis prefix
// is what makes "- **Advanced**" match: without it the lookahead saw ``*`` (not
// ``[A-Z]``) and silently skipped every bolded label, which is exactly how the
// "Experience / Advanced" bubble rendered glued onto one line. The trailing
// ``[A-Z]`` is still mandatory, so intra-word hyphens ("state-of-the-art",
// "Multi-region", "key-based") are never split. Their dash is followed by a
// lowercase letter.
const _INLINE_BULLET_LOOKAHEAD = '(?=(?:\\*\\*|\\*|_|`)?[A-Z])';

// Split a single bullet line whose body contains inline "- " separators back
// into multiple bullets. The LLM sometimes emits a list as one run-on line:
//   "- provenance- Continuous visibility- Pre-configured GitHub Actions"
// We split only when the dash follows a word/closing-bracket character and is
// followed by " " + (optional emphasis) + a capital letter. That pattern is
// reliably an inline bullet boundary and won't fire on intra-word hyphens like
// "key-based" or "Multi-region".
const _INLINE_BULLET_SPLIT_RE = new RegExp(`(?<=[a-z0-9)\\]])-[ \\t]+${_INLINE_BULLET_LOOKAHEAD}`);
const _splitInlineBullets = (line) => {
    const match = line.match(_LIST_PREFIX_RE);
    if (!match) return [line];
    const [, prefix, body] = match;
    const parts = body.split(_INLINE_BULLET_SPLIT_RE);
    if (parts.length === 1) return [line];
    return parts.map((p) => prefix + p.trim());
};

// Regex to find inline bullet boundaries inside a non-list paragraph.
// Matches a dash that is NOT preceded by whitespace (so it isn't a line-start
// marker) and IS followed by (optional emphasis) + a capital letter, the
// reliable LLM pattern for run-on inline lists like
// "integration.- Custom Software- **Application Dev**…". Does NOT fire on
// intra-word hyphens ("User-friendly", "well-known") because those are
// followed by a lowercase letter.
const _PARA_INLINE_BULLET_RE = new RegExp(`(?<!\\s)-[ \\t]+${_INLINE_BULLET_LOOKAHEAD}`);

// Split a regular (non-list) paragraph that contains inline bullet separators
// into a proper intro + indented list. Returns null when no bullets detected.
const _splitParaInlineBullets = (line) => {
    if (!_PARA_INLINE_BULLET_RE.test(line)) return null;
    const parts = line.split(_PARA_INLINE_BULLET_RE);
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
        // Indented continuation of the bullet. Leave alone.
        if (/^[ \t]+\S/.test(next) && !/^[ \t]*(?:[-*+]|\d+[.)])\s/.test(next)) continue;
        out.push('');
    }

    return out.join('\n')
        // Ensure a space before **Bold** when the LLM glues it directly after a
        // word: "communicationKey benefits:" → "communication **Key benefits:"
        // Only fires when a lowercase letter precedes ** and an uppercase follows,
        // so it won't touch closing ** or intra-word patterns like "re**start**".
        .replace(/([a-z])\*\*(?=[A-Z])/g, '$1 **')
        // Strip em-dashes from bot output. LLMs over-use them and the brand
        // prefers a plain comma cadence. The pattern MUST keep the literal
        // em-dash (U+2014): it matches model output at runtime, so widening it
        // to a plain hyphen makes it eat markdown bullets, turning
        // "- **Sales**" into ", **Sales**". Collapsing the surrounding
        // whitespace keeps the replacement a single comma break, never ", , ".
        // Runs before the follow-up paragraph rules so a question like "...we
        // offer SEO, which area interests you?" still gets the proper break
        // afterwards. Only applied in the bot renderer; user-typed em-dashes
        // are preserved.
        .replace(/\s*\u2014\s*/g, ', ')
        .replace(_FOLLOW_UP_PUNCT_GLUE_REGEX, '$1\n\n')
        .replace(_FOLLOW_UP_REGEX, '$1\n\n')
        .replace(_FOLLOW_UP_INLINE_REGEX, '$1\n\n');
};
