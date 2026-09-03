import React, { useState, useCallback, useEffect, useRef, Suspense } from 'react';
import ReactMarkdown from 'react-markdown';
import { Copy, Check, ThumbsUp, ThumbsDown } from 'lucide-react';
import BotAvatar from './BotAvatar';
import ErrorBoundary from './ErrorBoundary';
import { lazyWithRetry } from '../services/lazyWithRetry';
import { t } from '../i18n/i18n.js';
import { sanitizeColor } from '../services/sanitize';
import { formatBotMarkdown } from '../services/botMarkdown';
import { isSmartLink, isSmartLinkClicked, markSmartLinkClicked } from '../services/smartLinks';

// MediaCard (YouTube/downloadable-file cards) is lazy-loaded: it only renders on
// completed bot replies that carry a media_card, so keeping it out of the Chat
// chunk keeps the first-open payload lean. Consistent with the other on-demand
// cards (HandoffForm, MeetingBooking) that ChatWindow lazy-imports. lazyWithRetry
// + the ErrorBoundary at the render site keep a failed card load from taking the
// whole message (and widget) down, it just renders the answer text without the card.
const MediaCard = lazyWithRetry(() => import('./MediaCard'));

// Link rendering modes:
//   1. Inline icon. Link text is just an arrow glyph (↗, →, »). Used by the
//      bot when listing services with per-service URLs: each service gets a
//      tiny icon link beside its name (no underline, small, color-tinted).
//   2. Pill CTA. Link text matches one of the legacy "Explore services"
//      phrases. Renders as a full pill button. Kept for backward compat with
//      bots that still emit the v1 bottom-paragraph CTA.
//   3. Plain link. Everything else (contact pages, generic references).

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

    // Smart links (admin keyword→page map). Handled before the icon/pill/plain
    // branches so a smart link always gets this behaviour regardless of its
    // label. Once the visitor clicks one, it stops rendering as a link for the
    // rest of the conversation, the keyword shows as plain text on every later
    // answer. Scoped to smart-link URLs only, so service ↗ links and generic
    // references the bot writes are untouched. Opens in a new tab (like other
    // plain links) so clicking never closes the chat window.
    if (isSmartLink(href)) {
        if (isSmartLinkClicked(href)) {
            return <span {...props}>{children}</span>;
        }
        return (
            <a
                href={href}
                {...props}
                onClick={() => markSmartLinkClicked(href)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 font-medium hover:underline"
            >
                {children}
            </a>
        );
    }

    // Same-tab navigation for the service icon/pill CTAs. The widget persists
    // isOpen + session_id to sessionStorage so the conversation continues after
    // page navigation. (Plain links below open in a NEW tab instead. See there.)
    if (_isIconLink(text)) {
        return (
            <a
                href={href}
                rel="noopener"
                aria-label={t('message.open_service_aria') || 'Open service page'}
                title={t('message.open_service_title') || 'Open service page'}
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

    // Plain links (smart-link keywords, contact/reference pages) open in a NEW
    // tab so clicking one never unloads the host page or closes the chat window.
    // target/rel are set AFTER {...props} so an incoming prop can't override the
    // new-tab behaviour, and rel includes noreferrer alongside noopener.
    return (
        <a
            href={href}
            {...props}
            target="_blank"
            rel="noopener noreferrer"
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

// When a bot reply renders a media card (YouTube / downloadable file) below the
// answer, a trailing follow-up question (the qualification probe the bot weaves
// in on its own line) would otherwise sit ABOVE the card, in the middle. Split
// that trailing question off so it can render AFTER the card and always land
// last. The backend puts the follow-up on its own line separated by a blank line
// (``_ensure_followup_spacing`` + the prompt's EMBEDDING RULES), so the last
// paragraph is a reliable anchor. Conservative: only a short, single-line
// question with no list marker is treated as the follow-up.
const _splitTrailingFollowUp = (text) => {
    const src = (text || '').trimEnd();
    const idx = src.lastIndexOf('\n\n');
    if (idx === -1) return { body: text, followUp: '' };
    const tail = src.slice(idx + 2).trim();
    const isFollowUp =
        tail.endsWith('?') &&
        !tail.includes('\n') &&
        tail.length <= 160 &&
        !/^[-*+>#]|^\d+[.)]/.test(tail);
    if (!isFollowUp) return { body: text, followUp: '' };
    return { body: src.slice(0, idx).trimEnd(), followUp: tail };
};

const MessageBubble = ({
    msg,
    currentTheme,
    streamingId,
    settings,
    onFeedback,
}) => {
    // Hover-revealed action toolbar state. Local to each bot message so the
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
            // Toggle off when the user clicks the already-active reaction.
            // Matches the ChatGPT pattern of "undo my thumbs up".
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
        // Only reorder around a media card on a finished reply. Mid-stream the
        // card hasn't arrived yet and the text isn't final, so render as-is.
        // Split the FORMATTED text: formatBotMarkdown is what breaks the trailing
        // follow-up question onto its own paragraph (the blank line the split
        // keys off), so splitting the raw text would never see the separator.
        const hasCard = !!msg.media_card && !isStreaming;
        const formattedText = formatBotMarkdown(msg.text);
        const { body, followUp } = hasCard
            ? _splitTrailingFollowUp(formattedText)
            : { body: formattedText, followUp: '' };
        // AI message. Avatar + plain text, NO bubble
        return (
            <div className="group flex items-start gap-2 w-full">
                <div className="flex-shrink-0 mt-1">
                    <BotAvatar settings={settings || {}} size="xs" />
                </div>
                <div className="min-w-0 flex-1">
                    <div className={`text-[14px] ${currentTheme.botText}`}>
                        {/* `dir="auto"`: a reply's language is the
                            conversation's, not the interface's. A visitor
                            reading an Arabic panel can still be shown an
                            English answer, and vice versa. */}
                        <div dir="auto" className="prose prose-sm max-w-none break-words font-light">
                            <ReactMarkdown
                                components={{
                                    a: SafeLink,
                                }}
                            >
                                {body}
                            </ReactMarkdown>
                            {isStreaming && (
                                <span className="inline-block animate-pulse text-gray-400">▌</span>
                            )}
                        </div>
                        {/* Inline media card (YouTube video / downloadable file).
                            ``msg.media_card`` is populated by ChatWindow when the
                            stream's FINAL_METADATA carries a media_card object,
                            so it only renders on completed replies (never
                            mid-stream) and never on user turns. */}
                        {hasCard && (
                            <ErrorBoundary label="MediaCard" fallback={null}>
                                <Suspense fallback={null}>
                                    <MediaCard card={msg.media_card} secondary={msg.media_secondary} />
                                </Suspense>
                            </ErrorBoundary>
                        )}
                        {/* Follow-up question, split off the answer so it renders
                            AFTER the card (never sandwiched above it). */}
                        {followUp && (
                            <div className="prose prose-sm max-w-none break-words font-light mt-3">
                                <ReactMarkdown
                                    components={{
                                        a: SafeLink,
                                    }}
                                >
                                    {followUp}
                                </ReactMarkdown>
                            </div>
                        )}
                    </div>
                    {showActions && (
                        <div
                            className="flex items-center gap-1 mt-1.5 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100 transition-opacity duration-150"
                            aria-label={t('message.actions_aria') || 'Message actions'}
                        >
                            <MessageActionButton
                                label={copied ? (t('message.copied') || 'Copied') : (t('message.copy') || 'Copy message')}
                                onClick={handleCopy}
                                success={copied}
                            >
                                {copied
                                    ? <Check className="w-3.5 h-3.5" strokeWidth={2} />
                                    : <Copy className="w-3.5 h-3.5" strokeWidth={2} />}
                            </MessageActionButton>
                            <MessageActionButton
                                label={msg.feedback === 1 ? (t('message.remove_thumbs_up') || 'Remove thumbs up') : (t('message.helpful') || 'Helpful')}
                                onClick={() => handleFeedback(1)}
                                active={msg.feedback === 1}
                                activeClass="text-emerald-600 bg-emerald-50"
                            >
                                <ThumbsUp className="w-3.5 h-3.5" strokeWidth={2} />
                            </MessageActionButton>
                            <MessageActionButton
                                label={msg.feedback === -1 ? (t('message.remove_thumbs_down') || 'Remove thumbs down') : (t('message.not_helpful') || 'Not helpful')}
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

    // User message. Light blue bubble with dark text
    return (
        <div className="flex flex-col items-end">
            <div className="flex justify-end w-full">
                <div
                    className={`max-w-[85%] px-4 py-3 text-[14px] ${currentTheme.userBubble}`}
                    style={{ backgroundColor: sanitizeColor(settings?.user_bubble_color, currentTheme.userBubbleDefaultBg || '#DBE9FF') }}
                >
                    <div dir="auto" className="prose prose-sm max-w-none break-words">
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
