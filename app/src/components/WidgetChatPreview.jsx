import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { X, MoreHorizontal, Bot, Headphones, CalendarDays } from 'lucide-react';
import { formatBotMarkdown } from '../lib/formatBotMarkdown';
import PremiumOrb from './PremiumOrb';

function pathOf(url) {
    try {
        return new URL(url).pathname || url;
    } catch {
        return url;
    }
}

/**
 * PreviewBotAvatar - the bot avatar variant switch (orb / mascot / uploaded
 * logo / default), extracted once and reused by both the floating agent
 * badge and the per-message avatar so the two stay visually identical.
 * Mirrors widget/src/components/BotAvatar.jsx's `orb`/`mascot`/upload
 * branches (size tokens match its `xs`/`sm` presets).
 */
const PREVIEW_AVATAR_SIZES = {
    xs: { container: 'w-5 h-5', icon: 'w-[11px] h-[11px]', orbPx: 20 },
    sm: { container: 'w-7 h-7', icon: 'w-3.5 h-3.5', orbPx: 28 },
};

function PreviewBotAvatar({ settings, size = 'sm' }) {
    const s = PREVIEW_AVATAR_SIZES[size] || PREVIEW_AVATAR_SIZES.sm;
    const color = settings.orb_color || settings.primary_color;

    if (settings.avatar_type === 'orb') {
        return <PremiumOrb color={color} size={s.orbPx} className="flex-shrink-0" />;
    }
    if (settings.avatar_type === 'mascot') {
        return (
            <div className={`${s.container} rounded-full flex items-center justify-center flex-shrink-0`} style={{ backgroundColor: settings.primary_color }}>
                <Bot className={`${s.icon} text-white`} />
            </div>
        );
    }
    if (settings.bot_logo) {
        return <img src={settings.bot_logo} alt="logo" className={`${s.container} rounded-full object-cover flex-shrink-0`} />;
    }
    return (
        <div className={`${s.container} rounded-full flex items-center justify-center flex-shrink-0`} style={{ backgroundColor: settings.primary_color }}>
            <Bot className={`${s.icon} text-white`} />
        </div>
    );
}

/**
 * PreviewSafeLink - minimal safe link renderer for bot-message markdown.
 * Blocks non-http(s) URI schemes and opens external links in a new tab.
 * Mirrors the spirit (not the full pill/icon-link logic) of the widget's
 * `SafeLink` in widget/src/components/MessageBubble.jsx - this preview only
 * needs visual fidelity for plain links, not the CTA-pill/icon-link variants.
 */
function PreviewSafeLink({ href, children, ...props }) {
    const isSafe = typeof href === 'string' && /^https?:\/\//i.test(href);
    if (!isSafe) {
        return <span {...props}>{children}</span>;
    }
    return (
        <a href={href} target="_blank" rel="noopener noreferrer" {...props} className="text-blue-600 font-medium hover:underline">
            {children}
        </a>
    );
}

/**
 * Font stack used by the embeddable widget (see widget/src/index.css `:host`).
 * Applied to the Live Preview subtree so its typography matches the real
 * rendered widget instead of inheriting the dashboard's Inter body font.
 *
 * Must stay byte-identical to `--font-sans` in widget/src/index.css — that
 * file carries the note on why no Office-bundled face (Calibri, Gill Sans MT)
 * may lead it. If you change one, change both, or the preview starts lying
 * about what visitors see.
 */
export const WIDGET_FONT_STACK =
    "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif";

/**
 * WidgetChatPreview - a faithful, static mock of the embeddable chat widget's
 * classic (light) theme, extracted verbatim from BotSettings' inline Live
 * Preview so Bot Settings and the Build Studio render pixel-identically and both
 * stay pinned to the real widget (see widget/src/components/{themeConfigs,
 * ChatWindow,WelcomeScreen,ChatInput,MessageBubble,BotAvatar}.jsx).
 *
 * Presentational only: the caller owns the `state` tab switcher and passes the
 * current view; this component just renders the matching subtree.
 *
 * @param {Object}  props
 * @param {Object}  props.settings   Plain object carrying the widget fields the
 *   preview reads: `bot_name`, `bot_logo`, `avatar_type`, `orb_color`,
 *   `primary_color`, `welcome_title`, `welcome_subtitle`, `welcome_suggestions`,
 *   `waiting_message`, `offline_message`, `live_chat_enabled`,
 *   `live_chat_allowed` (entitlement gate; defaults to allowed when omitted),
 *   `meeting_booking_enabled`, `widget_messages` (`welcome_suggestions_layout`,
 *   `welcome_suggestions`, `input_placeholder`), and `feature_flags`
 *   (`show_branding`).
 * @param {'chat'|'waiting'|'unavailable'} [props.state='chat'] Which view to render.
 * @param {Array<{role:'user'|'bot', text:string, sources?:string[]}>} [props.messages]
 *   When non-empty (chat state), renders a LIVE conversation in the message area
 *   instead of the welcome screen - used by the Build Studio Prove step so the
 *   agent proves itself inside the real widget. Omit for the static Bot Settings
 *   preview.
 * @param {boolean} [props.pending] Bot is answering - shows a typing indicator.
 * @param {(question: string) => void} [props.onSend] When provided, the input
 *   becomes a real controlled text field that submits into this handler (the
 *   Build Studio Prove step, so the widget preview doubles as the actual
 *   input surface). Omit for the static Bot Settings preview, which keeps the
 *   presentational placeholder instead.
 * @param {string} [props.className] Extra classes for the outer widget frame.
 */
export default function WidgetChatPreview({ settings, state = 'chat', messages = [], pending = false, onSend, className = '' }) {
    // Live-chat affordance is gated by both the bot toggle and the plan
    // entitlement. When the entitlement isn't supplied (e.g. the Build Studio,
    // which has no per-field lock context) treat it as allowed.
    const liveChatAllowed = settings.live_chat_allowed !== false;

    // Interactive mode: once a conversation exists, the message area shows the
    // real Q&A instead of the welcome overlay (Build Studio Prove step).
    const hasConversation = state === 'chat' && (messages.length > 0 || pending);
    // Show the typing dots only while we're waiting for the FIRST token. Once the
    // trailing bot bubble has streamed text, that bubble IS the "typing" - the
    // dots would then double up beneath it.
    const lastMsg = messages[messages.length - 1];
    const showTyping = pending && !(lastMsg && lastMsg.role === 'bot' && lastMsg.text);
    const scrollRef = useRef(null);
    useEffect(() => {
        scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }, [messages, pending]);

    // Interactive input (Build Studio only - gated on `onSend` being supplied).
    const [draft, setDraft] = useState('');
    const submitDraft = () => {
        const q = draft.trim();
        if (!q || pending || !onSend) return;
        onSend(q);
        setDraft('');
    };

    return (
        /* Chat Window Preview Wrapper - mirrors the real widget's classic
           (light) theme 1:1 (see widget/src/components/{themeConfigs,
           ChatWindow,WelcomeScreen,ChatInput}.jsx). The font stack
           matches widget/src/index.css so the preview can't drift from
           what visitors actually see. */
        <div
            className={`widget-chat-preview w-full max-w-[380px] bg-[#F8F8F8] rounded-2xl overflow-hidden shadow-xl flex flex-col border border-[#BBE7FF]/30 transition-colors ${className}`}
            style={{ fontFamily: WIDGET_FONT_STACK }}
        >

            {/* 1. Header bar - date/time + action icons. The "···" menu
                mirrors the widget: on the welcome screen its only entry is
                "Leave a message", which shows solely in bot mode when live
                chat is OFF. "New chat" (+) needs a prior user message, so it
                never appears here. */}
            <div className="bg-[#F8F8F8] px-5 py-2 flex items-center justify-between shrink-0">
                <span className="text-[11px] text-gray-400 font-medium tracking-wide">
                    {new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} &middot; {new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                </span>
                <div className="flex items-center gap-1">
                    {state === 'chat' && !settings.live_chat_enabled && (
                        <div className="w-7 h-7 rounded-full flex items-center justify-center text-gray-400">
                            <MoreHorizontal className="w-4 h-4" />
                        </div>
                    )}
                    <div className="w-7 h-7 flex items-center justify-center text-gray-400">
                        <X className="w-5 h-5" />
                    </div>
                </div>
            </div>

            {/* 2. Floating agent badge - avatar + bot name only (no
                subtitle, no status dot), matching renderAgentBadge(). */}
            {state === 'chat' && (
                <div className="shrink-0 flex justify-center -mt-3 -mb-5 relative z-30">
                    <div
                        className="inline-flex items-center gap-2 rounded-full pl-1.5 pr-3.5 py-1.5 shadow-lg border border-white/40"
                        style={{ background: 'rgba(255,255,255,0.92)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}
                    >
                        <PreviewBotAvatar settings={settings} size="sm" />
                        <span className="text-[12px] font-semibold text-[#16202C] leading-tight">
                            {settings.bot_name || 'AI Assistant'}
                        </span>
                    </div>
                </div>
            )}

            {/* 3. Messages area - the welcome overlay is bottom-anchored
                (justify-end), exactly like the widget's welcome screen. */}
            <div
                className="relative flex-grow overflow-hidden min-h-[420px] bg-[#F8F8F8]"
                style={{ paddingTop: state === 'chat' ? 24 : undefined }}
            >
                {hasConversation && (
                    <div ref={scrollRef} className="absolute inset-0 z-10 overflow-y-auto flex flex-col gap-3 px-4 py-4" style={{ backgroundColor: '#F8F8F8' }}>
                        {messages.map((m, i) =>
                            m.role === 'user' ? (
                                <div key={i} className="flex justify-end">
                                    <div
                                        className="max-w-[80%] rounded-2xl rounded-br-md px-3.5 py-2 text-[14px] text-white whitespace-pre-wrap break-words"
                                        style={{ backgroundColor: settings.primary_color }}
                                    >
                                        {m.text}
                                    </div>
                                </div>
                            ) : (
                                // Bot message intentionally has NO bubble - mirrors
                                // widget/src/components/MessageBubble.jsx's bot branch
                                // ("AI message - avatar + plain text, NO bubble"). Do
                                // not add bg-white/border/rounded-*/shadow here; that
                                // would regress the live-preview fidelity fix.
                                <div key={i} className="flex items-start gap-2 w-full">
                                    <div className="flex-shrink-0 mt-1">
                                        <PreviewBotAvatar settings={settings} size="xs" />
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <div className="text-[14px] text-[#16202C] font-light break-words">
                                            <div className="prose prose-sm max-w-none break-words font-light">
                                                <ReactMarkdown components={{ a: PreviewSafeLink }}>
                                                    {formatBotMarkdown(m.text)}
                                                </ReactMarkdown>
                                            </div>
                                        </div>
                                        {Array.isArray(m.sources) && m.sources.length > 0 && (
                                            <div className="flex flex-wrap gap-1.5 mt-1.5">
                                                {m.sources.slice(0, 3).map((s, j) => (
                                                    <span
                                                        key={j}
                                                        className="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded-md bg-gray-100 text-gray-500"
                                                        title={s}
                                                    >
                                                        ◆ {pathOf(s)}
                                                    </span>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )
                        )}
                        {showTyping && (
                            // Same no-bubble treatment as a completed bot turn - avatar
                            // + bouncing dots, no white box around them.
                            <div className="flex items-start gap-2 w-full">
                                <div className="flex-shrink-0 mt-1">
                                    <PreviewBotAvatar settings={settings} size="xs" />
                                </div>
                                <div className="flex items-center gap-1.5 py-2">
                                    <span className="w-1.5 h-1.5 rounded-full bg-gray-300 animate-bounce" style={{ animationDelay: '0ms' }} />
                                    <span className="w-1.5 h-1.5 rounded-full bg-gray-300 animate-bounce" style={{ animationDelay: '120ms' }} />
                                    <span className="w-1.5 h-1.5 rounded-full bg-gray-300 animate-bounce" style={{ animationDelay: '240ms' }} />
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {state === 'chat' && !hasConversation && (() => {
                    // Mirror WelcomeScreen.jsx: greeting (emoji stripped, with a
                    // time-of-day fallback), subtitle, and the suggestion pills
                    // whose layout follows the MessagesTab vertical/horizontal
                    // toggle so this preview updates live.
                    const widgetMessages = settings.widget_messages || {};
                    const previewIsVertical = widgetMessages.welcome_suggestions_layout === 'vertical';
                    const previewSuggestions = (
                        Array.isArray(widgetMessages.welcome_suggestions) && widgetMessages.welcome_suggestions.length > 0
                            ? widgetMessages.welcome_suggestions
                            : (Array.isArray(settings.welcome_suggestions) && settings.welcome_suggestions.length > 0
                                ? settings.welcome_suggestions
                                : ['Our Services', 'About us', 'Contact us'])
                    ).filter(Boolean);
                    const hour = new Date().getHours();
                    const fallbackGreeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
                    const greeting = (settings.welcome_title || fallbackGreeting).replace(/\p{Emoji}/gu, '').trim();
                    return (
                        <div className="absolute inset-0 z-10 flex flex-col items-start justify-end px-5 pb-4" style={{ backgroundColor: '#F8F8F8' }}>
                            <div className="flex flex-col items-start text-left w-full">
                                <h2 className="text-2xl font-bold text-[#16202C]">{greeting}</h2>
                                <p className={`text-[15px] text-gray-500 ${previewIsVertical ? 'mt-1 mb-3' : 'mt-1'}`}>
                                    {settings.welcome_subtitle || 'How can I help you today?'}
                                </p>
                                <div
                                    className={
                                        previewIsVertical
                                            ? 'flex flex-col gap-2 mt-2 w-full items-stretch'
                                            : 'flex flex-wrap gap-2 mt-5 justify-start'
                                    }
                                >
                                    {previewSuggestions.map((s, i) => (
                                        <span
                                            key={s}
                                            className={
                                                previewIsVertical
                                                    ? 'w-full text-left px-4 py-2.5 rounded-xl text-[13px] text-gray-700 bg-gray-50 border border-gray-200 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 transition-colors cursor-pointer'
                                                    : 'px-4 py-2 rounded-full text-[13px] text-gray-600 bg-gray-50 border border-gray-200 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 transition-colors cursor-pointer'
                                            }
                                            style={{ animation: `fade-up 0.3s ease-out ${i * 0.08}s both` }}
                                        >
                                            {s}
                                        </span>
                                    ))}
                                </div>
                            </div>
                        </div>
                    );
                })()}

                {state === 'waiting' && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center px-5 py-4 gap-2 text-center">
                        <div
                            className="w-14 h-14 rounded-full flex items-center justify-center"
                            style={{ backgroundColor: `${settings.primary_color}22` }}
                        >
                            <div
                                className="w-8 h-8 rounded-full border-2 border-t-transparent animate-spin"
                                style={{ borderColor: `${settings.primary_color} transparent transparent transparent` }}
                            />
                        </div>
                        <p className="text-[14px] font-semibold text-[#16202C]">
                            {settings.waiting_message || 'Connecting you to support...'}
                        </p>
                    </div>
                )}

                {state === 'unavailable' && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center px-5 py-4 gap-2 text-center">
                        <div className="w-14 h-14 rounded-full bg-gray-100 flex items-center justify-center">
                            <Bot className="w-7 h-7 text-gray-400" />
                        </div>
                        <p className="text-[14px] font-semibold text-[#16202C]">
                            {settings.offline_message || "We'll be right back! Leave a message and we'll follow up shortly."}
                        </p>
                    </div>
                )}
            </div>

            {/* 4. Input + footer - chat state only. Mirrors ChatInput.jsx:
                the empty-state send icon is #BBE7FF (not the brand color),
                and the action bar carries icon-only affordances on the left
                with the "Powered by OyeChats" link on the right (gated by the
                show_branding feature flag). */}
            {state === 'chat' && (
                <div className="px-4 pb-4 pt-2 bg-[#F8F8F8] shrink-0">
                    {/* Input box - a real controlled field when `onSend` is
                        supplied (Build Studio Prove step); otherwise the
                        original presentational placeholder (Bot Settings). */}
                    <div className="rounded-2xl border border-[#BBE7FF]/50 bg-white px-3 py-2 shadow-sm flex items-end gap-2">
                        {onSend ? (
                            <>
                                <div className="flex-1 min-w-0">
                                    <input
                                        type="text"
                                        value={draft}
                                        onChange={(e) => setDraft(e.target.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') submitDraft();
                                        }}
                                        placeholder={(settings.widget_messages || {}).input_placeholder || 'Write a message...'}
                                        aria-label="Message"
                                        disabled={pending}
                                        className="flex-1 min-w-0 w-full text-[14px] leading-[20px] bg-transparent outline-none border-0 text-[#16202C] placeholder:text-gray-400 disabled:opacity-60"
                                    />
                                </div>
                                <button
                                    type="button"
                                    onClick={submitDraft}
                                    disabled={pending || !draft.trim()}
                                    aria-label="Send"
                                    className="mb-0.5 flex-shrink-0 text-[#BBE7FF] disabled:opacity-60"
                                >
                                    <svg width="18" height="18" viewBox="0 0 30 30" fill="none" xmlns="http://www.w3.org/2000/svg">
                                        <path d="M29.0178 16.0651L28.5877 16.4951L2.66773 29.7851C1.93773 30.1551 1.07772 30.0051 0.537723 29.4551C0.00772303 28.9251 -0.172253 28.0851 0.187747 27.3651L5.28772 17.1651L17.4377 14.9951L5.25775 12.7751L0.207767 2.67508C-0.162233 1.93508 -0.022277 1.09507 0.537723 0.535067C1.06772 0.00506717 1.91775 -0.174899 2.62775 0.195101L28.5577 13.4551L29.0277 13.9251C29.4377 14.6151 29.4377 15.3851 29.0277 16.0751L29.0178 16.0651Z" fill="currentColor" />
                                    </svg>
                                </button>
                            </>
                        ) : (
                            <>
                                <div className="flex-1 min-w-0">
                                    <span className="block text-[14px] text-gray-400 leading-[20px] truncate">
                                        {(settings.widget_messages || {}).input_placeholder || 'Write a message...'}
                                    </span>
                                </div>
                                <svg width="18" height="18" viewBox="0 0 30 30" fill="none" xmlns="http://www.w3.org/2000/svg" className="mb-0.5 flex-shrink-0 text-[#BBE7FF]">
                                    <path d="M29.0178 16.0651L28.5877 16.4951L2.66773 29.7851C1.93773 30.1551 1.07772 30.0051 0.537723 29.4551C0.00772303 28.9251 -0.172253 28.0851 0.187747 27.3651L5.28772 17.1651L17.4377 14.9951L5.25775 12.7751L0.207767 2.67508C-0.162233 1.93508 -0.022277 1.09507 0.537723 0.535067C1.06772 0.00506717 1.91775 -0.174899 2.62775 0.195101L28.5577 13.4551L29.0277 13.9251C29.4377 14.6151 29.4377 15.3851 29.0277 16.0751L29.0178 16.0651Z" fill="currentColor" />
                                </svg>
                            </>
                        )}
                    </div>

                    {/* Privacy notice */}
                    <p className="text-[10px] text-gray-400 leading-snug mt-2 px-1">
                        This chat may be monitored and recorded according to our{' '}
                        <a
                            href="https://www.oyechats.com/legal/privacy"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-semibold underline text-gray-500 hover:text-gray-700 transition-colors"
                        >
                            Privacy Policy
                        </a>
                        .
                    </p>

                    {/* Action bar - handoff / meeting icons + branding */}
                    <div className="flex items-center justify-between gap-3 mt-3.5 pt-1 px-1">
                        <div className="flex items-center gap-3 min-w-0">
                            {settings.live_chat_enabled && liveChatAllowed && (
                                <span className="flex items-center gap-1 text-[11px]" style={{ color: '#9ca3af' }} title="Live chat">
                                    <Headphones size={12} />
                                </span>
                            )}
                            {settings.meeting_booking_enabled && (
                                <span className="flex items-center gap-1 text-[11px] text-gray-400" title="Book a meeting">
                                    <CalendarDays size={12} />
                                </span>
                            )}
                        </div>
                        {settings.feature_flags?.show_branding !== false && (
                            <a
                                href="https://www.oyechats.com"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-[10px] text-gray-300 hover:text-gray-400 transition-colors"
                            >
                                Powered by OyeChats
                            </a>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
