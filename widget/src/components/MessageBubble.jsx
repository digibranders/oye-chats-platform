import React from 'react';
import ReactMarkdown from 'react-markdown';
import BotAvatar from './BotAvatar';

const SafeLink = ({ href, ...props }) => {
    // Block javascript:, data:, vbscript: and other dangerous URI schemes
    const isSafe = typeof href === 'string' && /^https?:\/\//i.test(href);
    if (!isSafe) {
        return <span {...props} />;
    }
    return <a href={href} {...props} className="text-blue-600 font-medium hover:underline" target="_blank" rel="noopener noreferrer" />;
};

const MessageBubble = ({
    msg,
    currentTheme,
    streamingId,
    settings,
}) => {
    if (msg.sender === 'bot') {
        // AI message — avatar + plain text, NO bubble
        return (
            <div className="flex items-start gap-2 w-full">
                <div className="flex-shrink-0 mt-1">
                    <BotAvatar settings={settings || {}} size="xs" />
                </div>
                <div className="min-w-0 flex-1">
                    <div className={`text-[14px] ${currentTheme.botText}`}>
                        <div className="prose prose-sm max-w-none break-words font-light">
                            <ReactMarkdown
                                components={{
                                    a: SafeLink,
                                }}
                            >
                                {msg.text}
                            </ReactMarkdown>
                            {streamingId === msg.id && (
                                <span className="inline-block animate-pulse text-gray-400">▌</span>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    // User message — light blue bubble with dark text
    return (
        <div className="flex flex-col items-end">
            <div className="flex justify-end w-full">
                <div
                    className={`max-w-[85%] px-4 py-3 text-[14px] ${currentTheme.userBubble}`}
                    style={{ backgroundColor: settings?.user_bubble_color || currentTheme.userBubbleDefaultBg || '#DBE9FF' }}
                >
                    <div className="prose prose-sm max-w-none break-words">
                        <ReactMarkdown
                            components={{
                                a: SafeLink,
                            }}
                        >
                            {msg.text}
                        </ReactMarkdown>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default MessageBubble;
