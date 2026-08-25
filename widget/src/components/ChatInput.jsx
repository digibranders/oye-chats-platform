import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Paperclip, CalendarDays } from 'lucide-react';
import SendIcon from './SendIcon';
import {
    SLASH_COMMANDS,
    SLASH_HINT_THRESHOLD,
    autocompleteSlashCommand,
    filterSlashCommands,
    findActiveSlashToken,
    matchSlashCommand,
} from '../lib/slashCommands';
import { getSlashHintSeenKey } from '../services/storage-keys';
import { t } from '../i18n/i18n.js';
import { SEEDED, authoredCopy } from '../i18n/seededCopy.js';
import {
    buildBrandingHref,
    resolveBrandingText,
    splitBrandingText,
} from '../services/brandingLink';

// Read the "visitor has already seen the slash palette" flag for this bot.
// sessionStorage-scoped so a fresh visit weeks later gets the hint again if
// they've forgotten, and a current tab stops repeating the same nudge.
// Safe against disabled storage (private mode, SecurityError). Treat as
// "not seen" and let the hint keep showing.
function readSlashHintSeen() {
    try {
        if (typeof sessionStorage === 'undefined') return false;
        return sessionStorage.getItem(getSlashHintSeenKey()) === '1';
    } catch {
        return false;
    }
}

function persistSlashHintSeen() {
    try {
        if (typeof sessionStorage === 'undefined') return;
        sessionStorage.setItem(getSlashHintSeenKey(), '1');
    } catch {
        /* storage disabled, the in-memory state still hides the hint for this session */
    }
}

/**
 * Unified chat input for both bot mode and live-chat mode.
 *
 * Bot mode:  onSubmit is called with the form event, inputText is controlled externally.
 * Live mode: onLiveSend is called with the trimmed text string; typing events go to onLiveTyping.
 *            The "Live chat" action bar is hidden; "End chat" link appears above the input.
 */
const ChatInput = ({
    // Shared props
    inputText,
    setInputText,
    currentTheme,
    inputRef,
    placeholder,
    settings = {},
    primaryColor,
    showBranding = false,
    // Bot mode
    onSubmit,
    isTyping = false,
    onHandoff,
    showProminentHandoff = false,
    // Live mode
    chatMode = 'bot',
    onLiveSend,
    onLiveTyping,
    onEndChat,
    onFilePick,
    onPaste,
    fileSharing = false,
    isReconnecting = false,
    uploadProgress = null,
    onBookMeeting,
    meetingBookingEnabled = false,
    // Mobile keyboard
    onInputFocus,
    onInputBlur,
    // True once the visitor has sent at least one message. Drives the
    // mobile-only privacy-notice collapse so the tiny mobile viewport
    // reclaims the vertical space above the input after the conversation
    // has started (desktop keeps the notice visible throughout).
    userHasSent = false,
    // Number of visitor-authored messages in the current session. Drives
    // the slash-command placeholder hint (`Write a message… or press / for
    // commands`) after the visitor is past the initial exchanges.
    userMessageCount = 0,
    // Slash-command handlers. Bot mode only, the popover / interception
    // stay dormant in live and waiting modes to avoid stealing keystrokes
    // once a human operator is involved.
    onNewChat,
    onClearMessages,
}) => {
    // Badge href/label come from the bot's own branding settings. Memoised on
    // the two inputs that can change; the bot key is a page-lifetime global set
    // by the loader, so it is read directly rather than threaded as a prop.
    const branding = useMemo(() => {
        const text = resolveBrandingText(settings?.branding_text);
        return {
            href: buildBrandingHref(
                settings?.branding_url,
                typeof window !== 'undefined' ? window.OYECHATS_BOT_KEY : undefined,
            ),
            ...splitBrandingText(text),
        };
    }, [settings?.branding_text, settings?.branding_url]);

    const messages = settings?.widget_messages || {};
    const inputPlaceholder =
        authoredCopy(messages.input_placeholder, SEEDED.input_placeholder)
        || placeholder
        || t('input.placeholder')
        || SEEDED.input_placeholder;

    const isWaiting = chatMode === 'waiting';
    const isLive = chatMode === 'live';
    const isBotMode = !isLive && !isWaiting;

    // Handler lookup by registry key. Lets the popover run any command
    // without a switch statement here. A command whose handler prop was
    // not provided (e.g. onHandoff omitted when live chat is disabled)
    // is filtered out of the palette entirely below.
    const commandHandlers = { onNewChat, onClearMessages, onHandoff };
    // A command is available when (a) its handler was actually wired by the
    // parent (e.g. onHandoff is dropped when live chat is disabled) AND
    // (b) its ``isAvailable`` predicate is satisfied for the current session
    // context. The second gate hides no-op commands on a fresh chat.
    // /clear and /new do nothing visible when the transcript only holds
    // the welcome bot message.
    const commandContext = { userMessageCount };
    const availableCommands = useMemo(
        () =>
            SLASH_COMMANDS.filter(
                (c) =>
                    typeof commandHandlers[c.handlerKey] === 'function' &&
                    (typeof c.isAvailable !== 'function' || c.isAvailable(commandContext)),
            ),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [onNewChat, onClearMessages, onHandoff, userMessageCount],
    );

    // "Visitor has demonstrated they know about slash commands" state.
    // Seeded from sessionStorage so a mid-session widget close/reopen keeps
    // the flag; flipped on the first popoverOpen transition below. Silences
    // the placeholder hint once discovered. Repeat exposure past that
    // point reads as nagging.
    const [slashHintSeen, setSlashHintSeen] = useState(() => readSlashHintSeen());

    // Popover + confirm state. `pendingConfirm` non-null suppresses the
    // popover and swaps the composer's action row for a Yes/Cancel bar so a
    // destructive command (currently `/new`) can never fire on a stray Enter.
    // `dismissedFor` remembers the exact input value at which the visitor
    // pressed Esc so the popover stays hidden until they type something new
    //. Otherwise every keystroke would re-open it.
    const [popoverIndex, setPopoverIndex] = useState(0);
    const [pendingConfirm, setPendingConfirm] = useState(null);
    const [dismissedFor, setDismissedFor] = useState(null);
    // ``originalQuery``, the last raw text the visitor typed before they
    // started previewing rows via ArrowUp/ArrowDown. Filtering runs against
    // this, not against the previewed value, so arrowing to ``/human``
    // doesn't collapse the palette down to just ``/human`` and lock further
    // navigation. Cleared on any real keystroke, or when the popover closes.
    const [originalQuery, setOriginalQuery] = useState(null);
    const filterSource = originalQuery !== null ? originalQuery : inputText;

    const filteredCommands = useMemo(() => {
        if (!isBotMode || pendingConfirm) return [];
        if (dismissedFor !== null && dismissedFor === inputText) return [];
        const filtered = filterSlashCommands(filterSource);
        const allowed = new Set(availableCommands.map((c) => c.name));
        return filtered.filter((c) => allowed.has(c.name));
    }, [filterSource, inputText, isBotMode, pendingConfirm, dismissedFor, availableCommands]);

    const popoverOpen = filteredCommands.length > 0;

    // First time the popover opens this session, mark the hint as seen,
    // the visitor has clearly figured out slash commands exist, so the
    // "press / for commands" placeholder can stop nagging them. Guarded
    // against setState-during-render by running in an effect and by the
    // ``slashHintSeen`` early-out so re-opens are cheap no-ops.
    useEffect(() => {
        if (popoverOpen && !slashHintSeen) {
            setSlashHintSeen(true);
            persistSlashHintSeen();
        }
    }, [popoverOpen, slashHintSeen]);

    // Keep the highlighted row in range as the query narrows the list.
    useEffect(() => {
        if (popoverIndex > filteredCommands.length - 1) {
            setPopoverIndex(0);
        }
    }, [filteredCommands.length, popoverIndex]);

    // Reset the Esc-dismissal the moment the visitor edits the input to a
    // different value. Otherwise typing a new `/` after Esc wouldn't
    // re-open the palette.
    useEffect(() => {
        if (dismissedFor !== null && dismissedFor !== inputText) {
            setDismissedFor(null);
        }
    }, [inputText, dismissedFor]);

    // Whenever the popover closes for any reason (command run, live-mode
    // switch, filter matches drop to zero) drop any preview-baseline state
    // so the next open of the palette starts from the visitor's fresh
    // input, not a stale query from a previous session.
    useEffect(() => {
        if (filteredCommands.length === 0 && originalQuery !== null) {
            setOriginalQuery(null);
        }
    }, [filteredCommands.length, originalQuery]);

    // Autocomplete the active slash token to `/<name>` at its current
    // position (does NOT execute the command). Used by Tab and by clicking
    // a popover row when the input has surrounding text; leaves the rest
    // of the sentence intact so the visitor never loses what they typed.
    const autocompleteFromPopover = (command) => {
        if (!command) return;
        const result = autocompleteSlashCommand(inputText, command);
        if (!result) return;
        setInputText(result.value);
        // Tab / click commits the preview, the previewed value becomes the
        // new baseline for any further filtering, so clear originalQuery.
        setOriginalQuery(null);
        // Defer caret placement until React commits the new value.
        setTimeout(() => {
            const el = inputRef?.current;
            if (!el) return;
            el.focus();
            try {
                el.setSelectionRange(result.caret, result.caret);
            } catch {
                // Some environments throw on setSelectionRange for disabled
                // or unmounted elements. Safe to ignore.
            }
        }, 0);
    };

    // Preview the highlighted command into the composer without committing.
    // Splices `/<name>` in place of the active slash token in the visitor's
    // ORIGINAL query (captured on first arrow keystroke) so surrounding text
    // is preserved and repeated arrows always splice against the same
    // baseline instead of stacking previews onto each other.
    const previewCommandInInput = (command, baselineQuery) => {
        if (!command) return;
        const result = autocompleteSlashCommand(baselineQuery, command);
        if (!result) return;
        setInputText(result.value);
        setTimeout(() => {
            const el = inputRef?.current;
            if (!el) return;
            el.focus();
            try {
                el.setSelectionRange(result.caret, result.caret);
            } catch {
                // Ignore, same rationale as autocompleteFromPopover.
            }
        }, 0);
    };

    const hasSeenSlashHint = slashHintSeen;
    const effectivePlaceholder = !hasSeenSlashHint && userMessageCount >= SLASH_HINT_THRESHOLD
        ? (t('input.slash_hint') || 'Write a message... or press / for commands')
        : inputPlaceholder;

    // Inline slash-token highlight, the pill visible under the visitor's
    // text as they type. Only computed when a matched (or matching-prefix)
    // command exists so an unrecognised token like "/foo" renders as plain
    // text. Splits the input into { pre, token, post } for the mirror div.
    const highlightedSlash = useMemo(() => {
        if (!isBotMode) return null;
        const token = findActiveSlashToken(inputText);
        if (!token) return null;
        const allowed = new Set(availableCommands.map((c) => c.name));
        const anyMatch =
            token.query === '' ||
            SLASH_COMMANDS.some((c) => allowed.has(c.name) && c.name.startsWith(token.query));
        if (!anyMatch) return null;
        return {
            pre: inputText.slice(0, token.start),
            token: inputText.slice(token.start, token.end),
            post: inputText.slice(token.end),
        };
    }, [inputText, isBotMode, availableCommands]);

    const mirrorRef = useRef(null);
    const handleTextareaScroll = (e) => {
        // Keep the ghost overlay's scroll offset synced so the pill stays
        // pinned to the correct line if the visitor writes past the 60px cap.
        if (mirrorRef.current) mirrorRef.current.scrollTop = e.target.scrollTop;
    };
    // Colour the pill from the visitor's theme colour when we have one so
    // the token subtly matches the send-button accent; fall back to a
    // neutral violet tint otherwise.
    const pillTint = primaryColor
        ? `${primaryColor}22` // ~13% alpha via 8-digit hex. Cross-browser safe
        : 'rgba(139, 92, 246, 0.14)';

    const runCommand = (command) => {
        if (!command) return;
        const handler = commandHandlers[command.handlerKey];
        if (!handler) return;
        setInputText('');
        // Clear preview-mode state too. Without this the frozen originalQuery
        // (e.g. "/") keeps the palette open after the command runs, the
        // filter reads originalQuery instead of the now-empty inputText and
        // renders whatever's still available. The Esc dismissal for the
        // pre-run value is also stale now that the input is cleared, so
        // wipe it as well.
        setOriginalQuery(null);
        setDismissedFor(null);
        setPopoverIndex(0);
        if (inputRef?.current) inputRef.current.style.height = 'auto';
        if (command.destructive) {
            setPendingConfirm(command);
        } else {
            handler();
        }
    };

    const confirmPending = () => {
        const cmd = pendingConfirm;
        setPendingConfirm(null);
        if (!cmd) return;
        const handler = commandHandlers[cmd.handlerKey];
        handler?.();
        // Belt-and-suspenders: runCommand already cleared these when the
        // confirm was queued, but the handler could re-inject state (a
        // future command that pre-fills the composer). Keeps the popover
        // state consistent regardless of what the handler does.
        setOriginalQuery(null);
        setDismissedFor(null);
        setPopoverIndex(0);
        // Refocus the composer so the next keystroke lands where the visitor
        // expects, the confirm bar just took focus for the Yes button.
        setTimeout(() => inputRef?.current?.focus?.(), 0);
    };

    const cancelPending = () => {
        setPendingConfirm(null);
        setTimeout(() => inputRef?.current?.focus?.(), 0);
    };

    const handleFocus = () => {
        // Wait for keyboard animation to settle, then scroll messages to bottom
        // so the input stays visible above the keyboard.
        // We call onInputFocus (passed from ChatWindow) instead of scrollIntoView
        // because scrollIntoView escapes the Shadow DOM and scrolls the host page.
        setTimeout(() => {
            onInputFocus?.();
        }, 350);
    };

    const handleBlur = () => {
        // On iOS, visualViewport.resize doesn't always fire reliably when the
        // keyboard is dismissed. Force a viewport re-sync after the keyboard
        // dismiss animation completes so the widget restores to full height.
        setTimeout(() => {
            onInputBlur?.();
        }, 400);
    };

    const handleChange = (e) => {
        setInputText(e.target.value);
        // Any real keystroke ends preview mode. This typed value becomes the
        // new baseline for filtering. Without this, the visitor would arrow to
        // /human (input previews `/human`), then start typing, and the filter
        // would still be running against their original `/` query.
        setOriginalQuery(null);
        // Reset highlight to the first row on any real keystroke so a
        // fresh `/` (or edit to the query) starts navigation from the top
        // instead of resuming whatever index was left over from the last
        // popover session.
        setPopoverIndex(0);
        e.target.style.height = 'auto';
        e.target.style.height = Math.min(e.target.scrollHeight, 60) + 'px';
        if (isLive) onLiveTyping?.();
    };

    const handleKeyDown = (e) => {
        if (popoverOpen) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                // Freeze the visitor's typed query on the first arrow so
                // repeated arrows keep splicing against the same baseline
                // instead of stacking previews (arrowing to `/human` and
                // then to `/clear` would otherwise re-splice `/clear` into
                // whatever `/human` had left in the input).
                const baseline = originalQuery !== null ? originalQuery : inputText;
                if (originalQuery === null) setOriginalQuery(inputText);
                const nextIndex = e.key === 'ArrowDown'
                    ? (popoverIndex + 1) % filteredCommands.length
                    : (popoverIndex - 1 + filteredCommands.length) % filteredCommands.length;
                setPopoverIndex(nextIndex);
                previewCommandInInput(filteredCommands[nextIndex], baseline);
                return;
            }
            if (e.key === 'Escape') {
                // Close the popover but preserve the input, a visitor writing
                // "and/or" doesn't want Esc to erase their sentence. If a
                // preview was in flight, restore the original typed query so
                // Esc feels like a proper undo. Stays dismissed for the
                // restored input value until they type something new.
                e.preventDefault();
                const restored = originalQuery !== null ? originalQuery : inputText;
                if (originalQuery !== null) {
                    setInputText(restored);
                    setOriginalQuery(null);
                }
                setDismissedFor(restored);
                return;
            }
            if (e.key === 'Tab') {
                // Autocomplete IN PLACE at the active slash token so
                // surrounding text is preserved. Never executes the command
                // by itself, the visitor can review the result and press
                // Enter with just `/<name>` to run it.
                e.preventDefault();
                autocompleteFromPopover(filteredCommands[popoverIndex]);
                return;
            }
        }
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSubmit(e);
        }
    };

    const handleSubmit = (e) => {
        e?.preventDefault();
        // Guard against double-sends while bot is generating a response.
        // The textarea is intentionally NOT disabled during isTyping so that
        // the mobile keyboard stays open and users can type ahead.
        if (isTyping || isWaiting) return;
        // Slash-command interception. Deliberately WHOLE-INPUT-ONLY. A
        // mid-sentence match like "hello /human" is NOT intercepted: Enter
        // sends the text as a normal message so the visitor never silently
        // loses the sentence they typed. Only `/<name>` alone runs a command.
        if (isBotMode) {
            const matched = matchSlashCommand(inputText);
            if (matched && typeof commandHandlers[matched.handlerKey] === 'function') {
                runCommand(matched);
                return;
            }
        }
        if (isLive) {
            const text = inputText.trim();
            if (!text) return;
            onLiveSend?.(text);
            setInputText('');
            if (inputRef?.current) {
                inputRef.current.style.height = 'auto';
                inputRef.current.focus();
            }
        } else {
            onSubmit?.(e);
        }
        if (inputRef?.current) {
            inputRef.current.style.height = 'auto';
        }
    };

    const hasText = inputText.trim().length > 0;
    const sendDisabled = !hasText || isTyping || isWaiting;

    return (
        <div className={`${currentTheme.inputArea} oyechats-safe-bottom`}>
            {/* End chat link. Live mode only */}
            {isLive && (
                <div className="flex items-center justify-center mb-1.5">
                    <button
                        type="button"
                        onClick={onEndChat}
                        className="text-[11px] text-gray-400 hover:text-red-500 transition-colors focus-visible:outline-none"
                    >
                        {t('input.end_chat_return') || 'End chat and return to AI'}
                    </button>
                </div>
            )}

            {/* Slash-command popover. Floats above the composer so the
                highlighted row and the send button never overlap. */}
            {popoverOpen && (
                <div
                    role="listbox"
                    aria-label={t('input.commands_aria') || 'Chat commands'}
                    className="mb-2 rounded-xl border border-[#BBE7FF]/60 bg-white shadow-lg overflow-hidden"
                >
                    {filteredCommands.map((cmd, i) => {
                        const Icon = cmd.icon;
                        const active = i === popoverIndex;
                        return (
                            <button
                                key={cmd.name}
                                type="button"
                                role="option"
                                aria-selected={active}
                                onMouseEnter={() => setPopoverIndex(i)}
                                // onMouseDown (not onClick) so the textarea's
                                // blur doesn't fire before the handler runs on
                                // touch devices. Whole-input `/name` runs the
                                // command directly; mid-sentence match just
                                // autocompletes the token so the visitor keeps
                                // whatever they typed around it.
                                onMouseDown={(e) => {
                                    e.preventDefault();
                                    if (matchSlashCommand(inputText)) {
                                        runCommand(cmd);
                                    } else {
                                        autocompleteFromPopover(cmd);
                                    }
                                }}
                                className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors ${
                                    active ? 'bg-[#F0F8FF]' : 'bg-white hover:bg-[#F7FBFF]'
                                }`}
                            >
                                <Icon size={14} className="text-[#3A0CA3] flex-shrink-0" />
                                <span className="flex-1 min-w-0">
                                    <span className="block text-[13px] font-medium text-[#16202C] leading-tight">
                                        /{cmd.name}
                                    </span>
                                    <span className="block text-[11px] text-gray-500 leading-tight mt-0.5">
                                        {t(cmd.descriptionKey) || cmd.description}
                                    </span>
                                </span>
                            </button>
                        );
                    })}
                </div>
            )}

            <form onSubmit={handleSubmit}>
                <div className="rounded-2xl border border-[#BBE7FF]/50 bg-white px-3 py-2 shadow-sm flex items-end gap-2">
                    {/* File attachment. Live mode only */}
                    {isLive && fileSharing && (
                        <button
                            type="button"
                            onClick={onFilePick}
                            disabled={uploadProgress !== null || isReconnecting}
                            title={t('input.attach_file') || "Attach file"}
                            aria-label={t('input.attach_file') || "Attach file"}
                            className={`mb-0.5 flex-shrink-0 transition-opacity ${(uploadProgress !== null || isReconnecting) ? 'opacity-30 cursor-not-allowed' : 'opacity-60 hover:opacity-100'}`}
                        >
                            <Paperclip size={16} className="text-[#16202C]" />
                        </button>
                    )}

                    <div className="flex-1 min-w-0">
                        {/* File upload progress bar. Live mode only */}
                        {uploadProgress !== null && (
                            <div className="w-full h-1 bg-gray-100 rounded-full mb-1.5 overflow-hidden">
                                <div
                                    className="h-full rounded-full transition-all duration-300"
                                    style={{ width: `${uploadProgress}%`, backgroundColor: primaryColor || '#3A0CA3' }}
                                />
                            </div>
                        )}
                        {/* Textarea + ghost overlay. The mirror div renders
                            the same text with a pill-tinted span behind the
                            active slash token; the textarea sits on top with
                            transparent background so its text and caret paint
                            over the mirror's pill. Fonts, padding, whitespace
                            handling all match exactly so the pill lines up
                            character-for-character with the visible token. */}
                        <div className="relative w-full" style={{ position: 'relative', width: '100%' }}>
                            {highlightedSlash && (
                                <div
                                    ref={mirrorRef}
                                    aria-hidden="true"
                                    className="absolute inset-0 pointer-events-none"
                                    style={{
                                        // Explicit metrics so alignment survives when
                                        // the widget is mounted in a host page whose
                                        // stylesheet doesn't reach here (embed edge
                                        // cases, dev-host previews). Must match the
                                        // textarea's inherited font stack + size.
                                        position: 'absolute',
                                        inset: 0,
                                        pointerEvents: 'none',
                                        color: 'transparent',
                                        fontSize: '14px',
                                        lineHeight: '20px',
                                        fontFamily: 'inherit',
                                        letterSpacing: 'inherit',
                                        whiteSpace: 'pre-wrap',
                                        overflowWrap: 'break-word',
                                        wordBreak: 'break-word',
                                        overflow: 'hidden',
                                        maxHeight: '60px',
                                        margin: 0,
                                        padding: 0,
                                        border: 'none',
                                    }}
                                >
                                    {highlightedSlash.pre}
                                    <span
                                        style={{
                                            backgroundColor: pillTint,
                                            borderRadius: '3px',
                                            color: 'transparent',
                                        }}
                                    >
                                        {highlightedSlash.token}
                                    </span>
                                    {highlightedSlash.post}
                                    {/* Preserve the trailing-newline row browsers
                                        collapse in a div but keep in a textarea. */}
                                    {inputText.endsWith('\n') && '​'}
                                </div>
                            )}
                            <textarea
                                value={inputText}
                                onChange={handleChange}
                                onKeyDown={handleKeyDown}
                                onPaste={onPaste}
                                onFocus={handleFocus}
                                onBlur={handleBlur}
                                onScroll={handleTextareaScroll}
                                placeholder={
                                    isWaiting
                                        ? (t('system.connecting') || 'Connecting you with the support team...')
                                        : effectivePlaceholder
                                }
                                aria-label={t('input.message_aria') || 'Chat message input'}
                                className="relative w-full outline-none bg-transparent text-[14px] text-[#16202C] placeholder:text-gray-400 resize-none overflow-y-auto min-h-[20px] max-h-[60px] leading-[20px]"
                                style={{
                                    // Inline mirrors of the Tailwind sizing so the
                                    // ghost overlay above lines up correctly in any
                                    // embedding host, including the widget's dev
                                    // preview which doesn't load the widget CSS.
                                    // fontFamily: 'inherit' overrides the browser's
                                    // UA default of monospace on <textarea> so the
                                    // mirror div's inherited font stack matches.
                                    fontFamily: 'inherit',
                                    fontSize: '14px',
                                    lineHeight: '20px',
                                    border: 'none',
                                    margin: 0,
                                    padding: 0,
                                    scrollbarWidth: 'none',
                                }}
                                disabled={isWaiting || isReconnecting}
                                ref={inputRef}
                                rows={1}
                            />
                        </div>
                    </div>

                    <button
                        type="submit"
                        disabled={sendDisabled}
                        aria-label={t('input.send_aria') || "Send message"}
                        className="mb-0.5 flex-shrink-0 flex items-center justify-center transition-all disabled:cursor-not-allowed focus-visible:outline-none"
                    >
                        <SendIcon
                            size={18}
                            className={`transition-colors ${hasText && !isWaiting ? 'text-[#16202C]' : 'text-[#BBE7FF]'}`}
                        />
                    </button>
                </div>
            </form>

            {/* Inline confirm for destructive slash commands (currently /new).
                Sits in the same vertical slot as the action row so the
                composer height stays constant while the visitor decides. */}
            {pendingConfirm && (
                <div className="mt-3 px-1 flex items-center justify-between gap-3">
                    <span className="text-[12px] text-[#16202C]">
                        {pendingConfirm.name === 'new'
                            ? (t('input.confirm_new_chat')
                                || 'Start a new chat? This will clear the current conversation.')
                            : (t('input.confirm_run_command', { name: pendingConfirm.name })
                                || `Run /${pendingConfirm.name}?`)}
                    </span>
                    <span className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={cancelPending}
                            className="text-[12px] text-gray-500 hover:text-gray-700 px-2 py-1 rounded-md"
                        >
                            {t('input.cancel') || 'Cancel'}
                        </button>
                        <button
                            type="button"
                            onClick={confirmPending}
                            autoFocus
                            className="text-[12px] font-semibold text-white px-2.5 py-1 rounded-md"
                            style={{ backgroundColor: primaryColor || '#3A0CA3' }}
                        >
                            {t('input.yes') || 'Yes'}
                        </button>
                    </span>
                </div>
            )}

            {/* Action bar. Bot mode only. 3-column grid keeps the privacy
                link geometrically centered between the left icon cluster
                (headphones / meeting) and the right "Powered by" credit,
                regardless of how wide either side becomes. Hidden in
                live/waiting modes where consent is implied by the handoff. */}
            {!isLive && !isWaiting && !pendingConfirm && (
                <div className="grid grid-cols-3 items-center gap-3 mt-1 pt-0 md:mt-3.5 md:pt-1 px-1">
                    <div className="flex items-center gap-3 min-w-0 justify-self-start">
                        {onHandoff && (
                            <button
                                type="button"
                                onClick={onHandoff}
                                title={t('input.live_chat_aria') || 'Live chat'}
                                aria-label={t('input.live_chat_aria') || 'Live chat'}
                                className="flex items-center gap-1 text-[11px] transition-colors cursor-pointer"
                                style={{ color: showProminentHandoff ? (primaryColor || '#3A0CA3') : '#9ca3af' }}
                            >
                                <span className="relative flex-shrink-0">
                                    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3" />
                                    </svg>
                                    {showProminentHandoff && (
                                        <span
                                            className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full animate-pulse"
                                            style={{ backgroundColor: primaryColor || '#3A0CA3' }}
                                        />
                                    )}
                                </span>
                            </button>
                        )}
                        {meetingBookingEnabled && onBookMeeting && (
                            <button
                                type="button"
                                onClick={onBookMeeting}
                                title={t('input.book_meeting') || 'Book a meeting'}
                                aria-label={t('input.book_meeting') || 'Book a meeting'}
                                className="flex items-center gap-1 text-[11px] transition-colors cursor-pointer text-gray-400 hover:text-gray-600"
                            >
                                <CalendarDays size={12} />
                            </button>
                        )}
                    </div>
                    <p className={`text-[10px] text-gray-400 leading-snug text-center justify-self-center ${userHasSent ? 'hidden md:block' : ''}`}>
                        <a
                            href="https://www.oyechats.com/legal/privacy"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-semibold text-gray-300 hover:text-gray-400 transition-colors"
                        >
                            {t('input.privacy_policy') || 'Privacy Policy'}
                        </a>
                    </p>
                    {showBranding ? (
                        <a
                            href={branding.href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="whitespace-nowrap text-[10px] font-semibold text-gray-300 hover:text-gray-400 transition-colors justify-self-end"
                        >
                            {branding.lead ? `${branding.lead} ` : ''}
                            <span style={{ color: 'rgb(49% 23% 93%)' }}>{branding.brand}</span>
                        </a>
                    ) : (
                        <span className="justify-self-end" />
                    )}
                </div>
            )}
        </div>
    );
};

export default ChatInput;
