import React from 'react';
import { ThumbsUp, ThumbsDown, Copy, Check } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import StreamingText from './StreamingText';

const MessageBubble = ({
    msg,
    currentTheme,
    streamingId,
    setStreamingId,
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
                            {streamingId === msg.id ? (
                                <StreamingText
                                    text={msg.text}
                                    onComplete={() => setStreamingId(null)}
                                />
                            ) : (
                                <ReactMarkdown
                                    components={{
                                        a: ({ ...props }) => (
                                            <a {...props} className="text-blue-600 font-medium hover:underline" target="_blank" rel="noopener noreferrer" />
                                        )
                                    }}
                                >
                                    {msg.text}
                                </ReactMarkdown>
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
                                a: ({ ...props }) => (
                                    <a {...props} className="text-blue-700 font-medium hover:underline" target="_blank" rel="noopener noreferrer" />
                                )
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
