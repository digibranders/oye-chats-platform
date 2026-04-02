import React from 'react';
import { X, Paperclip } from 'lucide-react';
import SendIcon from './SendIcon';
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

    return (
        <div className={`${currentTheme.container} ${isAnimating === true ? 'widget-open' : isAnimating === false ? 'widget-close' : isAnimating === 'done' ? 'widget-visible' : 'widget-hidden'}`}>
            {/* Header — white bg, avatar + name, close X */}
            <div className={currentTheme.header}>
                <div className="flex items-center gap-3">
                    <BotAvatar settings={settings} size="md" />
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

            {/* Content — centered greeting + suggestions */}
            <div className="flex-1 flex flex-col items-center justify-center overflow-hidden px-5" style={{ backgroundColor: settings.background_color || '#ffffff' }}>
                <div className="flex flex-col items-center text-center" style={{ animation: 'fadeUp 0.4s ease-out' }}>
                    {/* Avatar glow */}
                    <div className="relative flex items-center justify-center mb-5">
                        <div
                            style={{
                                position: 'absolute',
                                width: 90,
                                height: 90,
                                borderRadius: '50%',
                                background: `radial-gradient(circle, ${settings.primary_color || '#2B66BC'}20 0%, transparent 70%)`,
                                filter: 'blur(10px)',
                            }}
                        />
                        <div className="relative">
                            <BotAvatar settings={settings} size="lg" />
                        </div>
                    </div>

                    {/* Greeting */}
                    <p className="text-gray-500 text-[15px]">{getGreeting()},</p>
                    <p className="text-[#16202C] text-lg font-bold mt-0.5">can I help you with something?</p>

                    {/* Suggestion pills */}
                    <div className="flex flex-wrap gap-2 mt-5 justify-center">
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

                    {/* Talk to a human — subtle link */}
                    {onTalkToHuman && (
                        <button
                            onClick={onTalkToHuman}
                            className="mt-4 text-[12px] text-gray-400 hover:text-indigo-600 transition-colors cursor-pointer"
                            style={{ animation: `fadeUp 0.3s ease-out ${suggestions.length * 0.08 + 0.1}s both` }}
                        >
                            or talk to a human
                        </button>
                    )}
                </div>
            </div>

            {/* Input — stacked: text on top, icons below */}
            <div className={currentTheme.inputArea}>
                <form onSubmit={(e) => onSend(e)}>
                    <div className="rounded-2xl border border-[#BBE7FF]/50 bg-white px-4 pt-3 pb-2 shadow-sm">
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
                            placeholder="Ask anything?"
                            className="w-full outline-none bg-transparent text-[14px] text-[#16202C] placeholder:text-gray-400 resize-none overflow-hidden min-h-[24px] max-h-[80px]"
                            style={{ border: 'none' }}
                            ref={inputRef}
                            rows={1}
                        />
                        <div className="flex items-center justify-between mt-2">
                            <button
                                type="button"
                                disabled
                                title="File sharing coming soon"
                                aria-label="Attach file (coming soon)"
                                className="opacity-30 cursor-not-allowed"
                            >
                                <Paperclip size={20} className="text-[#16202C]" />
                            </button>
                            <button
                                type="submit"
                                disabled={!hasText}
                                aria-label="Send message"
                                className="w-11 h-11 flex items-center justify-center transition-all disabled:cursor-not-allowed rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300"
                            >
                                <SendIcon size={20} className={`transition-colors ${hasText ? 'text-[#16202C]' : 'text-[#BBE7FF]'}`} />
                            </button>
                        </div>
                    </div>
                </form>
            </div>

            <style>{`
                @keyframes fadeUp {
                    from { opacity: 0; transform: translateY(8px); }
                    to { opacity: 1; transform: translateY(0); }
                }
            `}</style>
        </div>
    );
};

export default WelcomeScreen;
