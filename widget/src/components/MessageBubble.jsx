import React from 'react';
import ReactMarkdown from 'react-markdown';
import BotAvatar from './BotAvatar';
import { sanitizeColor } from '../services/sanitize';

// Link rendering modes:
//   1. Inline icon — link text is just an arrow glyph (↗, →, »). Used by the
//      bot when listing services with per-service URLs: each service gets a
//      tiny icon link beside its name (no underline, small, color-tinted).
//   2. Pill CTA — link text matches one of the legacy "Explore services"
//      phrases. Renders as a full pill button. Kept for backward compat with
//      bots that still emit the v1 bottom-paragraph CTA.
//   3. Plain link — everything else (contact pages, generic references).

const _CTA_PHRASES = /^(explore (all )?services|view (all )?services|see (all )?services|browse services)\b/i;

// Follow-up offer openers the LLM tends to tack onto the end of an answer
// ("If you want, I can share..."). Without a paragraph break the offer reads
// as part of the previous sentence; with one it visually separates the answer
// from the optional next step.
const _FOLLOW_UP_OPENERS = [
    "If you want",
    "If you'd like",
    "If you're interested",
    "Would you like",
    "Want me to",
    "Want to",
    "Should I",
    "Do you want",
    "Can I",
    "Let me know if",
    "Just let me know",
    "Happy to",
    "I can also",
    "I can share",
    "I can help",
];

const _FOLLOW_UP_REGEX = new RegExp(
    `([.!?])[ \\t]+(?=(?:${_FOLLOW_UP_OPENERS
        .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('|')})\\b)`,
    'g',
);

// Markdown bullet/numbered list line.
const _LIST_ITEM_RE = /^[ \t]*(?:[-*+]|\d+[.)])\s+\S/;
const _LIST_PREFIX_RE = /^([ \t]*(?:[-*+]|\d+[.)])\s+)(.*)$/;

// Split a single bullet line whose body contains inline "- " separators back
// into multiple bullets. The LLM sometimes emits a list as one run-on line:
//   "- provenance- Continuous visibility- Pre-configured GitHub Actions"
// We split only when the dash follows a word/closing-bracket character and is
// followed by " " + a capital letter — that pattern is reliably an inline
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

// Reformat bot markdown so the LLM's terse "list + follow-up paragraph"
// output renders with clear separation:
//   1. Always insert a blank line between a list and a subsequent paragraph
//      (otherwise GFM treats the paragraph as lazy continuation of the last
//      bullet, gluing them together visually).
//   2. Break common follow-up offer phrases onto their own paragraph so
//      suggestions sit a blank line below the answer.
//
// Safe to run on partial streaming text — the rules only add whitespace,
// never remove content, so re-running over progressively longer strings
// produces the same result as running once on the final string.
const formatBotMarkdown = (text) => {
    if (!text) return text;

    const rawLines = text.split('\n');
    const lines = [];
    for (const raw of rawLines) {
        if (_LIST_ITEM_RE.test(raw)) {
            for (const split of _splitInlineBullets(raw)) lines.push(split);
        } else {
            lines.push(raw);
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
        // Indented continuation of the bullet — leave alone.
        if (/^[ \t]+\S/.test(next) && !/^[ \t]*(?:[-*+]|\d+[.)])\s/.test(next)) continue;
        out.push('');
    }

    return out.join('\n').replace(_FOLLOW_UP_REGEX, '$1\n\n');
};

const _linkText = (children) =>
    React.Children.toArray(children)
        .map((c) => (typeof c === 'string' ? c : ''))
        .join('')
        .trim();

// Just an arrow / link glyph → render as a small inline icon link beside the
// preceding text. ``u`` flag is required because 🔗 is an astral codepoint
// (surrogate pair); without ``u`` the regex parser flags it as an unexpected
// surrogate pair and the file fails to lint/parse on stricter setups.
const _isIconLink = (text) => /^[↗→»🔗]$/u.test(text);

// Whole-text CTA phrase (optionally with arrow) → pill button.
const _isPillCta = (text) => {
    if (!text) return false;
    if (text.includes('→') && _CTA_PHRASES.test(text)) return true;
    if (text.includes('»') && _CTA_PHRASES.test(text)) return true;
    return _CTA_PHRASES.test(text);
};

const SafeLink = ({ href, children, ...props }) => {
    // Block javascript:, data:, vbscript: and other dangerous URI schemes
    const isSafe = typeof href === 'string' && /^https?:\/\//i.test(href);
    if (!isSafe) {
        return <span {...props}>{children}</span>;
    }

    const text = _linkText(children);

    // Same-tab navigation by default. The widget persists isOpen + session_id
    // to sessionStorage so the conversation continues after page navigation.
    if (_isIconLink(text)) {
        return (
            <a
                href={href}
                rel="noopener"
                aria-label="Open service page"
                title="Open service page"
                {...props}
                className="inline-flex items-center justify-center align-middle ml-1 w-5 h-5 rounded-md bg-blue-50 text-blue-600 text-[12px] no-underline hover:bg-blue-100 transition-colors"
            >
                {children}
            </a>
        );
    }

    if (_isPillCta(text)) {
        return (
            <a
                href={href}
                rel="noopener"
                {...props}
                className="inline-flex items-center gap-1.5 mt-1 px-3.5 py-1.5 rounded-full bg-blue-50 text-blue-700 text-[13px] font-semibold no-underline hover:bg-blue-100 transition-colors"
            >
                {children}
            </a>
        );
    }

    return (
        <a
            href={href}
            rel="noopener"
            {...props}
            className="text-blue-600 font-medium hover:underline"
        >
            {children}
        </a>
    );
};

const MessageBubble = ({
    msg,
    currentTheme,
    streamingId,
    settings,
}) => {
    if (msg.sender === 'bot') {
        // AI message — avatar + plain text, NO bubble
        return (
            <div className="flex items-start gap-2 w-full">
                <div className="flex-shrink-0 mt-1">
                    <BotAvatar settings={settings || {}} size="xs" />
                </div>
                <div className="min-w-0 flex-1">
                    <div className={`text-[14px] ${currentTheme.botText}`}>
                        <div className="prose prose-sm max-w-none break-words font-light">
                            <ReactMarkdown
                                components={{
                                    a: SafeLink,
                                }}
                            >
                                {formatBotMarkdown(msg.text)}
                            </ReactMarkdown>
                            {streamingId === msg.id && (
                                <span className="inline-block animate-pulse text-gray-400">▌</span>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    // User message — light blue bubble with dark text
    return (
        <div className="flex flex-col items-end">
            <div className="flex justify-end w-full">
                <div
                    className={`max-w-[85%] px-4 py-3 text-[14px] ${currentTheme.userBubble}`}
                    style={{ backgroundColor: sanitizeColor(settings?.user_bubble_color, currentTheme.userBubbleDefaultBg || '#DBE9FF') }}
                >
                    <div className="prose prose-sm max-w-none break-words">
                        <ReactMarkdown
                            components={{
                                a: SafeLink,
                            }}
                        >
                            {msg.text}
                        </ReactMarkdown>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default MessageBubble;
