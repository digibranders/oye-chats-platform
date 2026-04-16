import React from 'react';
import { Headphones, Paperclip, CalendarDays } from 'lucide-react';
import SendIcon from './SendIcon';

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
}) => {
    const messages = settings?.widget_messages || {};
    const inputPlaceholder = messages.input_placeholder || placeholder || 'Write a message...';
    const liveChatLabel = messages.live_chat_label || 'Live chat';

    const isWaiting = chatMode === 'waiting';
    const isLive = chatMode === 'live';

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
        e.target.style.height = 'auto';
        e.target.style.height = Math.min(e.target.scrollHeight, 60) + 'px';
        if (isLive) onLiveTyping?.();
    };

    const handleKeyDown = (e) => {
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
        if (isLive) {
            const text = inputText.trim();
            if (!text) return;
            onLiveSend?.(text);
            setInputText('');
            if (inputRef?.current) {
                inputRef.current.style.height = 'auto';
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
            {/* End chat link — live mode only */}
            {isLive && (
                <div className="flex items-center justify-center mb-1.5">
                    <button
                        type="button"
                        onClick={onEndChat}
                        className="text-[11px] text-gray-400 hover:text-red-500 transition-colors focus-visible:outline-none"
                    >
                        End chat and return to AI
                    </button>
                </div>
            )}

            <form onSubmit={handleSubmit}>
                <div className="rounded-2xl border border-[#BBE7FF]/50 bg-white px-3 py-2 shadow-sm flex items-end gap-2">
                    {/* File attachment — live mode only */}
                    {isLive && fileSharing && (
                        <button
                            type="button"
                            onClick={onFilePick}
                            disabled={uploadProgress !== null || isReconnecting}
                            title="Attach file"
                            aria-label="Attach file"
                            className={`mb-0.5 flex-shrink-0 transition-opacity ${(uploadProgress !== null || isReconnecting) ? 'opacity-30 cursor-not-allowed' : 'opacity-60 hover:opacity-100'}`}
                        >
                            <Paperclip size={16} className="text-[#16202C]" />
                        </button>
                    )}

                    <div className="flex-1 min-w-0">
                        {/* File upload progress bar — live mode only */}
                        {uploadProgress !== null && (
                            <div className="w-full h-1 bg-gray-100 rounded-full mb-1.5 overflow-hidden">
                                <div
                                    className="h-full rounded-full transition-all duration-300"
                                    style={{ width: `${uploadProgress}%`, backgroundColor: primaryColor || '#3A0CA3' }}
                                />
                            </div>
                        )}
                        <textarea
                            value={inputText}
                            onChange={handleChange}
                            onKeyDown={handleKeyDown}
                            onPaste={onPaste}
                            onFocus={handleFocus}
                            onBlur={handleBlur}
                            placeholder={isWaiting ? 'Connecting you with the support team...' : inputPlaceholder}
                            aria-label="Chat message input"
                            className="w-full outline-none bg-transparent text-[14px] text-[#16202C] placeholder:text-gray-400 resize-none overflow-y-auto min-h-[20px] max-h-[60px] leading-[20px]"
                            style={{ border: 'none', margin: 0, scrollbarWidth: 'none' }}
                            disabled={isWaiting || isReconnecting}
                            ref={inputRef}
                            rows={1}
                        />
                    </div>

                    <button
                        type="submit"
                        disabled={sendDisabled}
                        aria-label="Send message"
                        className="mb-0.5 flex-shrink-0 flex items-center justify-center transition-all disabled:cursor-not-allowed focus-visible:outline-none"
                    >
                        <SendIcon
                            size={18}
                            className={`transition-colors ${hasText && !isWaiting ? 'text-[#16202C]' : 'text-[#BBE7FF]'}`}
                        />
                    </button>
                </div>
            </form>

            {/* Action bar — bot mode only */}
            {!isLive && !isWaiting && (
                <div className="flex items-center justify-between mt-2.5 px-1">
                    <div className="flex items-center gap-3">
                        {onHandoff && (
                            <button
                                type="button"
                                onClick={onHandoff}
                                title="Live chat"
                                aria-label="Live chat"
                                className="flex items-center gap-1 text-[11px] transition-colors cursor-pointer"
                                style={{ color: showProminentHandoff ? (primaryColor || '#3A0CA3') : '#9ca3af' }}
                            >
                                <span className="relative flex-shrink-0">
                                    <Headphones size={12} />
                                    {showProminentHandoff && (
                                        <span
                                            className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full animate-pulse"
                                            style={{ backgroundColor: primaryColor || '#3A0CA3' }}
                                        />
                                    )}
                                </span>
                                <span className={showProminentHandoff ? 'font-semibold' : 'font-normal'}>
                                    {liveChatLabel}
                                </span>
                            </button>
                        )}
                        {meetingBookingEnabled && onBookMeeting && (
                            <button
                                type="button"
                                onClick={onBookMeeting}
                                title="Book a meeting"
                                aria-label="Book a meeting"
                                className="flex items-center gap-1 text-[11px] transition-colors cursor-pointer text-gray-400 hover:text-gray-600"
                            >
                                <CalendarDays size={12} />
                                <span>Book meeting</span>
                            </button>
                        )}
                    </div>
                    {showBranding && (
                        <a
                            href="https://oyechats.com"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-[10px] text-gray-300 hover:text-gray-400 transition-colors"
                        >
                            Powered by OyeChats
                        </a>
                    )}
                </div>
            )}
        </div>
    );
};

export default ChatInput;
