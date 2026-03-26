import React from 'react';
import { ThumbsUp, ThumbsDown, Copy, Check } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import StreamingText from './StreamingText';
import BotAvatar from './BotAvatar';

const MessageBubble = ({
    msg,
    theme,
    currentTheme,
    settings,
    streamingId,
    setStreamingId,
    copiedId,
    onCopy,
    onFeedback,
}) => {
    if (msg.sender === 'bot') {
        return (
            <div className={`flex flex-col items-start`}>
                <div className="flex items-start gap-2.5 w-full">
                    <div className="flex-shrink-0 mt-1">
                        <BotAvatar settings={settings} size="sm" />
                    </div>
                    <div className="max-w-[80%]">
                        <div className={`p-3.5 text-sm ${currentTheme.botBubble}`}>
                            <div className="prose prose-sm max-w-none break-words">
                                {streamingId === msg.id ? (
                                    <StreamingText
                                        text={msg.text}
                                        onComplete={() => setStreamingId(null)}
                                    />
                                ) : (
                                    <ReactMarkdown
                                        components={{
                                            a: ({ node, ...props }) => (
                                                <a {...props} className={`${theme === 'modern' ? 'text-cyan-400' : 'text-black'} font-semibold hover:underline`} target="_blank" rel="noopener noreferrer" />
                                            )
                                        }}
                                    >
                                        {msg.text}
                                    </ReactMarkdown>
                                )}
                            </div>
                        </div>
                        {streamingId !== msg.id && (
                            <div className="flex items-center gap-2 mt-1 opacity-70 hover:opacity-100 transition-opacity">
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
            </div>
        );
    }

    // User message
    return (
        <div className={`flex flex-col items-end`}>
            <div className="flex justify-end w-full">
                <div
                    className={`max-w-[85%] p-3.5 text-sm rounded-2xl text-white shadow-md`}
                    style={{ backgroundColor: settings.primary_color }}
                >
                    <div className="prose prose-sm max-w-none break-words">
                        <ReactMarkdown
                            components={{
                                a: ({ node, ...props }) => (
                                    <a {...props} className={`${theme === 'modern' ? 'text-cyan-400' : 'text-white'} font-semibold hover:underline`} target="_blank" rel="noopener noreferrer" />
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
