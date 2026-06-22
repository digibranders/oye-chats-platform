import React from 'react';

const WelcomeScreen = ({ settings, onSend, welcomeExiting = false, exitDuration = 350 }) => {
    const messages = settings?.widget_messages || {};
    const suggestions = messages.welcome_suggestions || settings?.welcome_suggestions || ['Our Services', 'About us', 'Contact us'];
    // 'horizontal' (default) → pill row that wraps. 'vertical' → full-width
    // stacked rows that read like a menu. The greeting sits just above the
    // first action in both modes; vertical tightens that gap so the welcome
    // reads as the header of a stacked card.
    const layout = messages.welcome_suggestions_layout === 'vertical' ? 'vertical' : 'horizontal';
    const isVertical = layout === 'vertical';

    const getGreeting = () => {
        const hour = new Date().getHours();
        if (hour < 12) return 'Good morning';
        if (hour < 18) return 'Good afternoon';
        return 'Good evening';
    };

    const removeEmoji = (text) => {
        if (!text) return text;
        // Remove emoji and extra whitespace
        return text.replace(/[\p{Emoji}]/gu, '').trim();
    };

    const contentExitStyle = welcomeExiting ? {
        opacity: 0,
        transform: 'translateY(-20px)',
        transition: `opacity ${exitDuration}ms ease-out, transform ${exitDuration}ms ease-out`,
    } : undefined;

    return (
        <div
            className="flex flex-col items-start text-left w-full"
            style={contentExitStyle || { animation: 'fadeUp 0.4s ease-out' }}
        >
            <h2 className="text-2xl font-bold text-[#16202C]">{removeEmoji(settings?.welcome_title || getGreeting())}</h2>
            <p className={`text-[15px] text-gray-500 ${isVertical ? 'mt-1 mb-3' : 'mt-1'}`}>
                {settings?.welcome_subtitle || 'How can I help you today?'}
            </p>

            <div
                className={
                    isVertical
                        ? 'flex flex-col gap-2 mt-2 w-full items-stretch'
                        : 'flex flex-wrap gap-2 mt-5 justify-start'
                }
            >
                {suggestions.map((s, i) => (
                    <button
                        key={s}
                        onClick={() => onSend(null, s)}
                        className={
                            isVertical
                                ? 'w-full text-left px-4 py-2.5 rounded-xl text-[13px] text-gray-700 bg-gray-50 border border-gray-200 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 transition-colors cursor-pointer'
                                : 'px-4 py-2 rounded-full text-[13px] text-gray-600 bg-gray-50 border border-gray-200 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 transition-colors cursor-pointer'
                        }
                        style={welcomeExiting ? undefined : { animation: `fadeUp 0.3s ease-out ${i * 0.08}s both` }}
                    >
                        {s}
                    </button>
                ))}
            </div>

        </div>
    );
};

export default WelcomeScreen;
