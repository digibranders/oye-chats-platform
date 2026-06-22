import React from 'react';
import BotAvatar from './BotAvatar';
import { sanitizeColor } from '../services/sanitize';

/**
 * Typing indicator shown while the bot is generating a response.
 *
 * Three dots that bounce in sequence, in the bot's primary color. The
 * staggered animation delays produce a left-to-right wave so the indicator
 * feels alive without ever competing with the bot's actual message for
 * attention.
 *
 * Layout matches a bot message row: [BotAvatar] [Three bouncing dots]
 *
 * Props:
 *   settings — bot settings (primary_color, bot_logo, avatar_type)
 */

const TypingIndicator = ({ settings }) => {
    const primaryColor = sanitizeColor(settings?.primary_color, '#3A0CA3');

    const dotStyle = (delay) => ({
        width: '8px',
        height: '8px',
        borderRadius: '9999px',
        backgroundColor: primaryColor,
        opacity: 0.6,
        animation: `thinkingBounce 1.2s ease-in-out ${delay}s infinite`,
    });

    return (
        <div
            className="flex items-start gap-2 w-full"
            style={{ animation: 'fadeIn 240ms ease-out both' }}
        >
            <div className="flex-shrink-0" aria-hidden="true">
                <BotAvatar settings={settings || {}} size="xs" />
            </div>
            <div
                className="flex items-center gap-1.5 pt-2"
                role="status"
                aria-live="polite"
                aria-label="Typing"
            >
                <span style={dotStyle(0)} />
                <span style={dotStyle(0.2)} />
                <span style={dotStyle(0.4)} />
            </div>
        </div>
    );
};

export default TypingIndicator;
