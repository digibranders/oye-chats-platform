import React from 'react';

const TypingIndicator = () => {
    return (
        <div className="flex items-center gap-1 py-2">
            <span className="w-1.5 h-1.5 bg-gray-400 rounded-full" style={{ animation: 'typingDot 1.2s ease-in-out infinite' }} />
            <span className="w-1.5 h-1.5 bg-gray-400 rounded-full" style={{ animation: 'typingDot 1.2s ease-in-out 0.2s infinite' }} />
            <span className="w-1.5 h-1.5 bg-gray-400 rounded-full" style={{ animation: 'typingDot 1.2s ease-in-out 0.4s infinite' }} />
        </div>
    );
};

export default TypingIndicator;
