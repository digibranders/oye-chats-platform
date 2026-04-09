import React from 'react';
import BotAvatar from './BotAvatar';
import { sanitizeColor } from '../services/sanitize';

/**
 * Thinking loader shown while the bot is generating a response.
 *
 * Layout matches the bot message row:
 *   [BotAvatar]  [Three bouncing dots]
 *
 * Props:
 *   settings — bot settings (primary_color, bot_logo, avatar_type)
 */
const TypingIndicator = ({ settings }) => {
    const primaryColor = sanitizeColor(settings?.primary_color, '#3A0CA3');

    return (
        <div className="flex items-start gap-2 w-full">
            <div className="flex-shrink-0" aria-hidden="true">
                <BotAvatar settings={settings || {}} size="xs" />
            </div>

            <div
                className="flex items-center gap-1 pt-1"
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
