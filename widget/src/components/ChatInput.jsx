import React from 'react';
import { Headphones, ArrowUp } from 'lucide-react';

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
                <div className="rounded-xl border border-gray-200 bg-gray-50/80 px-3 py-2 transition-colors focus-within:border-gray-300 focus-within:bg-white">
                    <div className="flex items-end gap-2">
                        <textarea
                            value={inputText}
                            onChange={handleChange}
                            onKeyDown={handleKeyDown}
                            placeholder={placeholder || 'Type a message...'}
                            aria-label="Chat message input"
                            className="flex-1 outline-none bg-transparent text-[13px] text-[#16202C] placeholder:text-gray-400 resize-none overflow-hidden min-h-[20px] max-h-[80px]"
                            style={{ border: 'none' }}
                            disabled={isTyping}
                            ref={inputRef}
                            rows={1}
                        />
                        <button
                            type="submit"
                            disabled={!hasText || isTyping}
                            aria-label="Send message"
                            className={`w-8 h-8 flex-shrink-0 flex items-center justify-center rounded-full transition-all disabled:cursor-not-allowed ${
                                hasText ? 'bg-[#16202C] text-white' : 'text-gray-300'
                            }`}
                        >
                            <ArrowUp size={14} />
                        </button>
                    </div>
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
