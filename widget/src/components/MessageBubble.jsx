import React from 'react';
import { ThumbsUp, ThumbsDown, Copy, Check } from 'lucide-react';
import ReactMarkdown from 'react-markdown';

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
    copiedId,
    onCopy,
    onFeedback,
    settings,
}) => {
    if (msg.sender === 'bot') {
        // AI message — plain text, NO bubble
        return (
            <div className="flex flex-col items-start w-full">
                <div className="w-full">
                    <div className={`text-[14px] ${currentTheme.botText}`}>
                        <div className="prose prose-sm max-w-none break-words">
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
                    {streamingId !== msg.id && (
                        <div className="flex items-center gap-1.5 mt-2">
                            <button
                                onClick={() => onCopy(msg.text, msg.id)}
                                className="p-1 text-gray-400 hover:text-gray-600 transition-colors"
                                title="Copy response"
                            >
                                {copiedId === msg.id ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                            </button>
                            <button
                                onClick={() => onFeedback(msg.id, 'like')}
                                className={`p-1 transition-colors ${msg.feedback === 'like' ? 'text-green-500' : 'text-gray-400 hover:text-green-500'}`}
                                title="Good response"
                            >
                                <ThumbsUp className="w-3.5 h-3.5" />
                            </button>
                            <button
                                onClick={() => onFeedback(msg.id, 'dislike')}
                                className={`p-1 transition-colors ${msg.feedback === 'dislike' ? 'text-red-500' : 'text-gray-400 hover:text-red-500'}`}
                                title="Bad response"
                            >
                                <ThumbsDown className="w-3.5 h-3.5" />
                            </button>
                        </div>
                    )}
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
