import React from 'react';
import { Send } from 'lucide-react';

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

    return (
        <div className={currentTheme.inputArea} style={{ backgroundColor: settings.background_color }}>
            <form onSubmit={onSubmit} className="relative flex items-center gap-2">
                <div className="flex-1 relative">
                    <textarea
                        value={inputText}
                        onChange={handleChange}
                        onKeyDown={handleKeyDown}
                        placeholder={placeholder || `Reply to ${settings.bot_name}...`}
                        className={`w-full pl-4 pr-12 py-3 rounded-2xl focus:outline-none transition-all text-sm resize-none overflow-hidden min-h-[44px] max-h-[120px] ${currentTheme.inputBg}`}
                        disabled={isTyping}
                        ref={inputRef}
                        rows={1}
                    />
                </div>
                <button
                    type="submit"
                    disabled={!inputText.trim() || isTyping}
                    className={`w-10 h-10 rounded-full text-white flex items-center justify-center transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-md`}
                    style={{ backgroundColor: settings.primary_color }}
                >
                    <Send className="w-5 h-5 ml-0.5" />
                </button>
            </form>
        </div>
    );
};

export default ChatInput;
