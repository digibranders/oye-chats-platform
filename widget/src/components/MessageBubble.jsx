import React, { useState, useCallback, useEffect, useRef, Suspense } from 'react';
import ReactMarkdown from 'react-markdown';
import { Copy, Check, ThumbsUp, ThumbsDown } from 'lucide-react';
import BotAvatar from './BotAvatar';
import ErrorBoundary from './ErrorBoundary';
import { lazyWithRetry } from '../services/lazyWithRetry';
import { sanitizeColor } from '../services/sanitize';
import { formatBotMarkdown } from '../services/botMarkdown';

// MediaCard (YouTube/downloadable-file cards) is lazy-loaded: it only renders on
// completed bot replies that carry a media_card, so keeping it out of the Chat
// chunk keeps the first-open payload lean — consistent with the other on-demand
// cards (HandoffForm, MeetingBooking) that ChatWindow lazy-imports. lazyWithRetry
// + the ErrorBoundary at the render site keep a failed card load from taking the
// whole message (and widget) down — it just renders the answer text without the card.
const MediaCard = lazyWithRetry(() => import('./MediaCard'));

// Link rendering modes:
//   1. Inline icon — link text is just an arrow glyph (↗, →, »). Used by the
//      bot when listing services with per-service URLs: each service gets a
//      tiny icon link beside its name (no underline, small, color-tinted).
//   2. Pill CTA — link text matches one of the legacy "Explore services"
//      phrases. Renders as a full pill button. Kept for backward compat with
//      bots that still emit the v1 bottom-paragraph CTA.
//   3. Plain link — everything else (contact pages, generic references).

const _CTA_PHRASES = /^(explore (all )?services|view (all )?services|see (all )?services|browse services)\b/i;

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
                        {/* Inline media card (YouTube video / downloadable file).
                            ``msg.media_card`` is populated by ChatWindow when the
                            stream's FINAL_METADATA carries a media_card object,
                            so it only renders on completed replies — never
                            mid-stream — and never on user turns. */}
                        {msg.media_card && !isStreaming && (
                            <ErrorBoundary label="MediaCard" fallback={null}>
                                <Suspense fallback={null}>
                                    <MediaCard card={msg.media_card} secondary={msg.media_secondary} />
                                </Suspense>
                            </ErrorBoundary>
                        )}
                    </div>
                    {showActions && (
                        <div
                            className="flex items-center gap-1 mt-1.5 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100 transition-opacity duration-150"
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
