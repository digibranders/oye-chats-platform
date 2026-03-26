import React from 'react';
import BotAvatar from './BotAvatar';

const TypingIndicator = ({ settings, currentTheme }) => {
    return (
        <div className="flex items-start gap-2.5">
            <div className="flex-shrink-0 mt-1">
                <BotAvatar settings={settings} size="sm" />
            </div>
            <div className={`${currentTheme.botBubble} p-3 shadow-sm`}>
                <div className="flex gap-1">
                    <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"></span>
                    <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce delay-100"></span>
                    <span className="w-2 h-2 bg-gray-400 rounded-full animate-bounce delay-200"></span>
                </div>
            </div>
        </div>
    );
};

export default TypingIndicator;
``