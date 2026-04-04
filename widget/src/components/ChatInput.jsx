import React from 'react';
import { Headphones } from 'lucide-react';
import SendIcon from './SendIcon';

const ChatInput = ({ inputText, setInputText, onSubmit, isTyping, currentTheme, inputRef, placeholder, onHandoff, showProminentHandoff, primaryColor, showBranding = false }) => {
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
                {/* Single-row: textarea + send button side-by-side */}
                <div className="flex items-center gap-2 rounded-2xl border border-[#BBE7FF]/50 bg-white pl-4 pr-2 py-2.5 shadow-sm">
                    <textarea
                        value={inputText}
                        onChange={handleChange}
                        onKeyDown={handleKeyDown}
                        placeholder={placeholder || 'Type a message...'}
                        aria-label="Chat message input"
                        className="flex-1 outline-none bg-transparent text-[14px] text-[#16202C] placeholder:text-gray-400 resize-none overflow-hidden min-h-[20px] max-h-[80px] leading-[20px] py-0"
                        style={{ border: 'none', margin: 0 }}
                        disabled={isTyping}
                        ref={inputRef}
                        rows={1}
                    />
                    <button
                        type="submit"
                        disabled={!hasText || isTyping}
                        aria-label="Send message"
                        className="w-9 h-9 flex-shrink-0 flex items-center justify-center transition-all disabled:cursor-not-allowed rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300"
                    >
                        <SendIcon
                            size={18}
                            className={`transition-colors ${hasText ? 'text-[#16202C]' : 'text-[#BBE7FF]'}`}
                        />
                    </button>
                </div>
            </form>

            {/* Action bar — below input */}
            <div className="flex items-center justify-between mt-1.5 px-1">
                <div className="flex items-center gap-3">
                    {onHandoff && (
                        <button
                            type="button"
                            onClick={onHandoff}
                            title="Live chat"
                            aria-label="Live chat"
                            className="flex items-center gap-1 text-[11px] transition-colors"
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
                                Live chat
                            </span>
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
        </div>
    );
};

export default ChatInput;
