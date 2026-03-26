import React from 'react';
import { X, Send } from 'lucide-react';
import BotAvatar from './BotAvatar';

const WelcomeScreen = ({ settings, currentTheme, onClose, onSend, inputText, setInputText, inputRef }) => {
    const suggestions = ['Our Services', 'About us', 'Contact us'];

    const getGreeting = () => {
        const hour = new Date().getHours();
        if (hour < 12) return 'Good morning';
        if (hour < 18) return 'Good afternoon';
        return 'Good evening';
    };

    return (
        <div className={currentTheme.container}>
            {/* Header */}
            <div
                className="flex items-center justify-between px-5 py-3 shrink-0 transition-colors duration-500"
                style={{
                    backgroundColor: settings.header_color,
                    borderBottom: '1px solid rgba(255,255,255,0.1)'
                }}
            >
                <div className="flex items-center gap-2.5">
                    <BotAvatar settings={settings} size="sm" />
                    <span className="text-white text-sm font-medium" style={{ letterSpacing: '-0.02em' }}>
                        {settings.bot_name}
                    </span>
                </div>
                <button
                    onClick={onClose}
                    className="w-8 h-8 rounded-full bg-white/15 hover:bg-white/25 flex items-center justify-center transition-colors"
                >
                    <X size={16} className="text-white" />
                </button>
            </div>

            {/* Content */}
            <div className="flex-1 flex flex-col justify-between overflow-hidden" style={{ backgroundColor: settings.background_color }}>
                <div className="flex-1 overflow-y-auto px-5 py-4">
                    <div className="flex flex-col items-center" style={{ animation: 'fadeUp 0.4s ease-out' }}>
                        {/* Avatar with Glow */}
                        <div className="relative flex items-center justify-center" style={{ marginTop: 16, marginBottom: 24 }}>
                            <div
                                style={{
                                    position: 'absolute',
                                    width: 100,
                                    height: 100,
                                    borderRadius: '50%',
                                    background: `radial-gradient(circle, ${settings.primary_color}25 0%, transparent 70%)`,
                                    filter: 'blur(12px)',
                                }}
                            />
                            <div
                                className="rounded-full bg-white border-4 border-white flex items-center justify-center overflow-hidden relative"
                                style={{
                                    boxShadow: `0 8px 32px ${settings.primary_color}30, 0 2px 8px rgba(0,0,0,0.08)`
                                }}
                            >
                                <BotAvatar settings={settings} size="lg" />
                            </div>
                        </div>

                        {/* Date & Time */}
                        <p className="text-center" style={{ color: '#b0b0b0', fontSize: 11, margin: 0, letterSpacing: '0.02em' }}>
                            {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })} &middot; {new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                        </p>

                        {/* Greeting */}
                        <h2
                            className="text-center font-semibold text-lg"
                            style={{ color: '#1a1a1a', margin: '6px 0 0', lineHeight: 1.35, letterSpacing: '-0.02em' }}
                        >
                            {getGreeting()}
                            <br />
                            Can I help with anything?
                        </h2>
                        <p className="text-center mt-2" style={{ color: '#999', margin: '8px 0 0', fontSize: 13 }}>
                            Choose a prompt below or write your own to
                            <br />
                            start chatting with {settings.bot_name}
                        </p>

                        {/* Suggestions */}
                        <div className="flex flex-wrap gap-2.5 mt-6 w-full justify-center">
                            {suggestions.map((s, i) => (
                                <button
                                    key={s}
                                    onClick={() => onSend(null, s)}
                                    className="text-left px-4 py-3 rounded-2xl cursor-pointer transition-all hover:shadow-md"
                                    style={{
                                        border: '1px solid #e8e0e0',
                                        background: '#fefefe',
                                        color: '#333',
                                        fontSize: 13,
                                        lineHeight: 1.5,
                                        animation: `fadeUp 0.3s ease-out ${i * 0.1}s both`,
                                    }}
                                    onMouseEnter={(e) => {
                                        e.target.style.borderColor = settings.primary_color;
                                        e.target.style.boxShadow = `0 4px 12px ${settings.primary_color}20`;
                                    }}
                                    onMouseLeave={(e) => {
                                        e.target.style.borderColor = '#e8e0e0';
                                        e.target.style.boxShadow = 'none';
                                    }}
                                >
                                    {s}
                                </button>
                            ))}
                        </div>
                    </div>
                </div>

                {/* Input */}
                <div className="px-4 pb-3 pt-1">
                    <form onSubmit={(e) => onSend(e)}>
                        <div
                            className="flex items-center gap-2 rounded-2xl px-4 py-3"
                            style={{ border: '1px solid #c0c0c0', background: '#f3f3f3' }}
                        >
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
                                placeholder={`How can ${settings.bot_name} help you today?`}
                                className="flex-1 outline-none bg-transparent text-sm resize-none overflow-hidden min-h-[24px] max-h-[80px] text-gray-900 placeholder:text-gray-500"
                                style={{ fontSize: 13, border: 'none' }}
                                ref={inputRef}
                                rows={1}
                            />
                            <button
                                type="submit"
                                disabled={!inputText.trim()}
                                className="w-8 h-8 rounded-full text-white flex items-center justify-center transition-all disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
                                style={{ backgroundColor: inputText.trim() ? settings.primary_color : '#b0b0b0' }}
                            >
                                <Send size={14} />
                            </button>
                        </div>
                    </form>
                </div>
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
