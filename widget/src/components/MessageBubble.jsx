import React, { useState, useCallback, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import { Copy, Check, ThumbsUp, ThumbsDown } from 'lucide-react';
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
    "Would you",
    "Want me to",
    "Want to",
    "Want a",
    "Want",
    "Should I",
    "Do you",
    "Can I",
    "Is there",
    "Are you",
    "What would",
    "What best",
    "Which",
    "Let me know if",
    "Just let me know",
    "Happy to",
    "I can also",
    "I can share",
    "I can help",
];

const _FOLLOW_UP_OPENERS_RE = _FOLLOW_UP_OPENERS
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');

// Fires when the opener follows sentence-ending punctuation (existing case).
const _FOLLOW_UP_REGEX = new RegExp(
    `([.!?])[ \\t]+(?=(?:${_FOLLOW_UP_OPENERS_RE})\\b)`,
    'g',
);

// Fires when the opener is glued directly after a word (no punctuation gap) —
// e.g. the LLM emits "add-onDo you need…" with no newline or space.
const _FOLLOW_UP_INLINE_REGEX = new RegExp(
    `([a-z])[ \\t]*(?=(?:${_FOLLOW_UP_OPENERS_RE})\\b)`,
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

// Regex to find inline bullet boundaries inside a non-list paragraph.
// Matches a dash that is NOT preceded by whitespace (so it isn't a line-start
// marker) and IS followed by a capital letter — the reliable LLM pattern for
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
        // Indented continuation of the bullet — leave alone.
        if (/^[ \t]+\S/.test(next) && !/^[ \t]*(?:[-*+]|\d+[.)])\s/.test(next)) continue;
        out.push('');
    }

    return out.join('\n')
        // Ensure a space before **Bold** when the LLM glues it directly after a
        // word: "communicationKey benefits:" → "communication **Key benefits:"
        // Only fires when a lowercase letter precedes ** and an uppercase follows,
        // so it won't touch closing ** or intra-word patterns like "re**start**".
        .replace(/([a-z])\*\*(?=[A-Z])/g, '$1 **')
        .replace(_FOLLOW_UP_REGEX, '$1\n\n')
        .replace(_FOLLOW_UP_INLINE_REGEX, '$1\n\n');
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

// Strip markdown syntax for clipboard copy so the visitor gets plain text
// rather than raw asterisks/backticks/brackets pasted into their notes.
// Conservative: only touches the patterns the bot actually emits.
const _markdownToPlainText = (text) => {
    if (!text) return '';
    return text
        // Markdown links → just the visible label
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        // Bold / italic markers
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\*([^*]+)\*/g, '$1')
        .replace(/__([^_]+)__/g, '$1')
        .replace(/_([^_]+)_/g, '$1')
        // Inline code / code fences
        .replace(/```[a-z]*\n?/gi, '')
        .replace(/```/g, '')
        .replace(/`([^`]+)`/g, '$1')
        // Bullet markers at line start → keep the text, drop the marker
        .replace(/^[ \t]*[-*+][ \t]+/gm, '')
        .replace(/^[ \t]*\d+[.)][ \t]+/gm, '')
        .trim();
};

const MessageActionButton = ({ children, label, onClick, active = false, success = false, disabled = false, activeClass = 'text-blue-600 bg-blue-50' }) => (
    <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        title={label}
        className={`inline-flex items-center justify-center w-7 h-7 rounded-md transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed ${
            success
                ? 'text-emerald-600 bg-emerald-50'
                : active
                ? activeClass
                : 'text-gray-400 hover:text-gray-700 hover:bg-gray-100'
        }`}
    >
        {children}
    </button>
);

const MessageBubble = ({
    msg,
    currentTheme,
    streamingId,
    settings,
    onFeedback,
}) => {
    // Hover-revealed action toolbar state — local to each bot message so the
    // copied-confirmation flash on one reply doesn't bleed into siblings.
    const [copied, setCopied] = useState(false);
    const copyTimerRef = useRef(null);

    useEffect(() => () => clearTimeout(copyTimerRef.current), []);

    const handleCopy = useCallback(async () => {
        const plain = _markdownToPlainText(msg.text);
        if (!plain) return;
        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(plain);
            } else {
                // Fallback for non-secure-context environments (older Safari).
                const ta = document.createElement('textarea');
                ta.value = plain;
                ta.setAttribute('readonly', '');
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
            }
            setCopied(true);
            clearTimeout(copyTimerRef.current);
            copyTimerRef.current = setTimeout(() => setCopied(false), 1500);
        } catch (err) {
            console.warn('[OyeChats] Copy failed:', err);
        }
    }, [msg.text]);

    const handleFeedback = useCallback(
        (value) => {
            if (!onFeedback) return;
            // Toggle off when the user clicks the already-active reaction —
            // matches the ChatGPT pattern of "undo my thumbs up".
            const next = msg.feedback === value ? null : value;
            onFeedback(msg.id, next);
        },
        [onFeedback, msg.id, msg.feedback]
    );

    if (msg.sender === 'bot') {
        // Show the toolbar only on a finished, persisted reply. While the
        // stream is in flight ``msg.id`` is a local placeholder counter that
        // the feedback endpoint can't resolve to a real ChatMessage row.
        const isStreaming = streamingId === msg.id;
        const hasPersistedId = !!msg.id && !isStreaming && !!msg.text?.trim();
        const showActions = hasPersistedId && !!onFeedback;
        // AI message — avatar + plain text, NO bubble
        return (
            <div className="group flex items-start gap-2 w-full">
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
                            {isStreaming && (
                                <span className="inline-block animate-pulse text-gray-400">▌</span>
                            )}
                        </div>
                    </div>
                    {showActions && (
                        <div
                            className="flex items-center gap-1 mt-1.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity duration-150"
                            aria-label="Message actions"
                        >
                            <MessageActionButton
                                label={copied ? 'Copied' : 'Copy message'}
                                onClick={handleCopy}
                                success={copied}
                            >
                                {copied
                                    ? <Check className="w-3.5 h-3.5" strokeWidth={2} />
                                    : <Copy className="w-3.5 h-3.5" strokeWidth={2} />}
                            </MessageActionButton>
                            <MessageActionButton
                                label={msg.feedback === 1 ? 'Remove thumbs up' : 'Helpful'}
                                onClick={() => handleFeedback(1)}
                                active={msg.feedback === 1}
                                activeClass="text-emerald-600 bg-emerald-50"
                            >
                                <ThumbsUp className="w-3.5 h-3.5" strokeWidth={2} />
                            </MessageActionButton>
                            <MessageActionButton
                                label={msg.feedback === -1 ? 'Remove thumbs down' : 'Not helpful'}
                                onClick={() => handleFeedback(-1)}
                                active={msg.feedback === -1}
                                activeClass="text-rose-500 bg-rose-50"
                            >
                                <ThumbsDown className="w-3.5 h-3.5" strokeWidth={2} />
                            </MessageActionButton>
                        </div>
                    )}
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
