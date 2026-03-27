import React from 'react';
import { Paperclip } from 'lucide-react';
import SendIcon from './SendIcon';

const ChatInput = ({ inputText, setInputText, onSubmit, isTyping, settings, currentTheme, inputRef, placeholder }) => {
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
                        className="w-full outline-none bg-transparent text-[14px] text-[#16202C] placeholder:text-gray-400 resize-none overflow-hidden min-h-[24px] max-h-[100px]"
                        style={{ border: 'none' }}
                        disabled={isTyping}
                        ref={inputRef}
                        rows={1}
                    />

                    {/* Bottom row — paperclip left, send right */}
                    <div className="flex items-center justify-between mt-2">
                        <Paperclip
                            size={20}
                            className="text-[#16202C] cursor-pointer hover:text-gray-500 transition-colors"
                        />
                        <button
                            type="submit"
                            disabled={!hasText || isTyping}
                            className="transition-all disabled:cursor-not-allowed"
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
