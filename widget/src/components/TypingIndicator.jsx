import React from 'react';

/**
 * Thinking loader shown while the bot is generating a response.
 *
 * Layout matches the bot message row:
 *   [Avatar circle]  [Bubble with three bouncing dots]
 *
 * Props:
 *   settings     — bot settings (primary_color, bot_logo)
 *   currentTheme — theme config (botText, etc.)
 */
const TypingIndicator = ({ settings }) => {
    const primaryColor = settings?.primary_color || '#3A0CA3';
    const botLogo = settings?.bot_logo;

    return (
        <div className="flex items-end gap-2 w-full">
            {/* Bot avatar — mirrors how the bot identifies itself */}
            <div
                className="flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center overflow-hidden"
                style={{ backgroundColor: primaryColor }}
                aria-hidden="true"
            >
                {botLogo ? (
                    <img
                        src={botLogo}
                        alt=""
                        className="w-full h-full object-cover rounded-full"
                    />
                ) : (
                    <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        className="w-4 h-4 text-white"
                        stroke="currentColor"
                        strokeWidth={2.5}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                    >
                        <path d="M12 2a10 10 0 0 1 10 10c0 5.52-4.48 10-10 10S2 17.52 2 12 6.48 2 12 2z" />
                        <path d="M12 8v8M8 12h8" />
                    </svg>
                )}
            </div>

            {/* Bubble */}
            <div
                className="flex items-center gap-1 px-4 py-3 rounded-2xl rounded-bl-sm"
                style={{ backgroundColor: 'rgba(0,0,0,0.06)' }}
                role="status"
                aria-label="AI is thinking"
            >
                <span
                    className="w-2 h-2 rounded-full"
                    style={{
                        backgroundColor: primaryColor,
                        opacity: 0.7,
                        animation: 'thinkingBounce 1.2s ease-in-out 0s infinite',
                    }}
                />
                <span
                    className="w-2 h-2 rounded-full"
                    style={{
                        backgroundColor: primaryColor,
                        opacity: 0.7,
                        animation: 'thinkingBounce 1.2s ease-in-out 0.2s infinite',
                    }}
                />
                <span
                    className="w-2 h-2 rounded-full"
                    style={{
                        backgroundColor: primaryColor,
                        opacity: 0.7,
                        animation: 'thinkingBounce 1.2s ease-in-out 0.4s infinite',
                    }}
                />
            </div>
        </div>
    );
};

export default TypingIndicator;
