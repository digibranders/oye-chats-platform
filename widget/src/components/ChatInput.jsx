import React from 'react';
import { Headphones } from 'lucide-react';
import SendIcon from './SendIcon';

const ChatInput = ({ inputText, setInputText, onSubmit, isTyping, currentTheme, inputRef, placeholder, onHandoff, showProminentHandoff, primaryColor }) => {
    const handleChange = (e) => {
        setInputText(e.target.value);
        e.target.style.height = 'auto';
        e.target.style.height = e.target.scrollHeight + 'px';
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onSubmit(e);
        }
    };

    const hasText = inputText.trim().length > 0;

    return (
        <div className={currentTheme.inputArea}>
            <form onSubmit={onSubmit}>
                <div className="rounded-2xl border border-[#BBE7FF]/50 bg-white px-4 pt-3 pb-2 shadow-sm">
                    {/* Text area — top row */}
                    <textarea
                        value={inputText}
                        onChange={handleChange}
                        onKeyDown={handleKeyDown}
                        placeholder={placeholder || 'Ask anything?'}
                        aria-label="Chat message input"
                        className="w-full outline-none bg-transparent text-[14px] text-[#16202C] placeholder:text-gray-400 resize-none overflow-hidden min-h-[24px] max-h-[100px]"
                        style={{ border: 'none' }}
                        disabled={isTyping}
                        ref={inputRef}
                        rows={1}
                    />

                    {/* Bottom row — left action, send right */}
                    <div className="flex items-center justify-between mt-2">
                        {onHandoff ? (
                            /* Live chat — always visible, emphasis increases when bot is struggling */
                            <button
                                type="button"
                                onClick={onHandoff}
                                title="Live chat"
                                aria-label="Live chat"
                                className="relative flex items-center gap-1.5 transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-current rounded-md px-0.5"
                                style={{ color: showProminentHandoff ? (primaryColor || '#3A0CA3') : '#9ca3af' }}
                            >
                                <span className="relative flex-shrink-0">
                                    <Headphones size={16} />
                                    {/* Pulse dot — only when bot is struggling */}
                                    {showProminentHandoff && (
                                        <span
                                            className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full animate-pulse"
                                            style={{ backgroundColor: primaryColor || '#3A0CA3' }}
                                        />
                                    )}
                                </span>
                                {/* Label is always shown so users know what the button does */}
                                <span
                                    className={`text-[11px] leading-none whitespace-nowrap transition-all ${
                                        showProminentHandoff ? 'font-semibold' : 'font-normal'
                                    }`}
                                >
                                    Live chat
                                </span>
                            </button>
                        ) : (
                            /* Fallback spacer so send button stays right-aligned */
                            <span />
                        )}
                        <button
                            type="submit"
                            disabled={!hasText || isTyping}
                            aria-label="Send message"
                            className="w-11 h-11 flex items-center justify-center transition-all disabled:cursor-not-allowed rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300"
                        >
                            <SendIcon
                                size={20}
                                className={`transition-colors ${hasText ? 'text-[#16202C]' : 'text-[#BBE7FF]'}`}
                            />
                        </button>
                    </div>
                </div>
            </form>
        </div>
    );
};

export default ChatInput;
