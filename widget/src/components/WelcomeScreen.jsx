import React from 'react';
import { X, Headphones, ArrowUp } from 'lucide-react';
import BotAvatar from './BotAvatar';

const WelcomeScreen = ({ settings, currentTheme, onClose, onSend, inputText, setInputText, inputRef, isAnimating = true, onTalkToHuman }) => {
    const suggestions = settings?.welcome_suggestions || ['Our Services', 'About us', 'Contact us'];

    const getGreeting = () => {
        const hour = new Date().getHours();
        if (hour < 12) return 'Good morning';
        if (hour < 18) return 'Good afternoon';
        return 'Good evening';
    };

    const hasText = inputText.trim().length > 0;
    const showBranding = settings?.feature_flags?.show_branding !== false;

    return (
        <div className={`${currentTheme.container} ${isAnimating === true ? 'widget-open' : isAnimating === false ? 'widget-close' : isAnimating === 'done' ? 'widget-visible' : 'widget-hidden'}`}>
            {/* Compact header */}
            <div className={currentTheme.header}>
                <div className="flex items-center gap-2.5">
                    <BotAvatar settings={settings} size="header" />
                    <h3 className="font-semibold text-sm text-[#16202C]">{settings.bot_name}</h3>
                </div>
                <button
                    onClick={onClose}
                    className="w-7 h-7 flex items-center justify-center text-gray-400 hover:text-gray-600 transition-colors"
                    title="Close"
                >
                    <X className="w-5 h-5" />
                </button>
            </div>

            {/* Content — bottom-aligned, left-justified greeting + suggestion pills */}
            <div className="flex-1 flex flex-col items-start justify-end overflow-hidden px-5 pb-4" style={{ backgroundColor: settings.background_color || '#ffffff' }}>
                <div className="flex flex-col items-start text-left w-full" style={{ animation: 'fadeUp 0.4s ease-out' }}>
                    {/* Greeting — headline */}
                    <h2 className="text-2xl font-bold text-[#16202C]">{getGreeting()}</h2>
                    <p className="text-[15px] text-gray-500 mt-1">How can I help you today?</p>

                    {/* Suggestion pills */}
                    <div className="flex flex-wrap gap-2 mt-5 justify-start">
                        {suggestions.map((s, i) => (
                            <button
                                key={s}
                                onClick={() => onSend(null, s)}
                                className="px-4 py-2 rounded-full text-[13px] text-gray-600 bg-gray-50 border border-gray-200 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 transition-colors cursor-pointer"
                                style={{ animation: `fadeUp 0.3s ease-out ${i * 0.08}s both` }}
                            >
                                {s}
                            </button>
                        ))}
                    </div>
                </div>
            </div>

            {/* Slick input area */}
            <div className={currentTheme.inputArea}>
                <form onSubmit={(e) => onSend(e)}>
                    <div className="rounded-xl border border-gray-200 bg-gray-50/80 px-3 py-2 transition-colors focus-within:border-gray-300 focus-within:bg-white">
                        <div className="flex items-end gap-2">
                            <textarea
                                value={inputText}
                                onChange={(e) => {
                                    setInputText(e.target.value);
                                    e.target.style.height = 'auto';
                                    e.target.style.height = e.target.scrollHeight + 'px';
                                }}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' && !e.shiftKey) {
                                        e.preventDefault();
                                        onSend(e);
                                    }
                                }}
                                placeholder="Type a message..."
                                className="flex-1 outline-none bg-transparent text-[13px] text-[#16202C] placeholder:text-gray-400 resize-none overflow-hidden min-h-[20px] max-h-[80px]"
                                style={{ border: 'none' }}
                                ref={inputRef}
                                rows={1}
                            />
                            <button
                                type="submit"
                                disabled={!hasText}
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
                        {onTalkToHuman && (
                            <button
                                type="button"
                                onClick={onTalkToHuman}
                                title="Live chat"
                                aria-label="Live chat"
                                className="flex items-center gap-1 text-[11px] text-gray-400 hover:text-gray-600 transition-colors"
                            >
                                <Headphones size={12} className="flex-shrink-0" />
                                <span>Live chat</span>
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
        </div>
    );
};

export default WelcomeScreen;
