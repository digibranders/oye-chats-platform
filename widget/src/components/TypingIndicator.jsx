import React from 'react';
import BotAvatar from './BotAvatar';

/**
 * Typing indicator shown while the bot is generating a response.
 *
 * Layout matches a bot message row: [BotAvatar] [pill with three dots]
 *
 * Props:
 *   settings — bot settings (bot_logo, avatar_type)
 */

const TypingIndicator = ({ settings }) => {
    const dotStyle = (delay) => ({
        width: '6px',
        height: '6px',
        borderRadius: '9999px',
        background: '#9ca3af',
        animation: `typingDot 1.2s ease-in-out ${delay}s infinite`,
    });

    return (
        <div
            className="flex items-end gap-2 w-full"
            style={{ animation: 'fadeIn 180ms ease-out both' }}
        >
            <div className="flex-shrink-0" aria-hidden="true">
                <BotAvatar settings={settings || {}} size="xs" />
            </div>
            <div
                role="status"
                aria-live="polite"
                aria-label="Assistant is typing"
                className="flex items-center gap-1.5 px-3 py-2.5 rounded-2xl rounded-bl-sm"
                style={{ background: '#f3f4f6' }}
            >
                <span style={dotStyle(0)} />
                <span style={dotStyle(0.15)} />
                <span style={dotStyle(0.3)} />
            </div>
        </div>
    );
};

export default TypingIndicator;
