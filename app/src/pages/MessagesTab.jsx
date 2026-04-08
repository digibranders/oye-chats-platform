import React from 'react';

const DEFAULT_SUGGESTIONS = ['Our Services', 'About us', 'Contact us'];

/**
 * MessagesTab - Admin UI for customizing all widget user-facing messages
 * Organized into sections: Welcome Screen, Chat Interface, Offline Mode, Post-Chat
 */
const MessagesTab = ({ settings, onSettingsChange }) => {
    const messages = settings?.widget_messages || {};

    const suggestions =
        Array.isArray(messages.welcome_suggestions) && messages.welcome_suggestions.length > 0
            ? messages.welcome_suggestions
            : DEFAULT_SUGGESTIONS;

    const handleMessageChange = (key, value) => {
        onSettingsChange({
            widget_messages: {
                ...messages,
                [key]: value,
            },
        });
    };

    const handleSuggestionChange = (index, value) => {
        const newSuggestions = [...suggestions];
        newSuggestions[index] = value;
        handleMessageChange('welcome_suggestions', newSuggestions);
    };

    const addSuggestion = () => {
        handleMessageChange('welcome_suggestions', [...suggestions, '']);
    };

    const removeSuggestion = (index) => {
        handleMessageChange('welcome_suggestions', suggestions.filter((_, i) => i !== index));
    };

    return (
        <div className="space-y-8">
            {/* Welcome Screen Section */}
            <div className="border border-surface-200 dark:border-surface-700 rounded-lg p-6 bg-white dark:bg-surface-900">
                <h3 className="text-lg font-semibold mb-4 text-surface-900 dark:text-surface-100">Welcome Screen</h3>

                <div className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-2">
                            Greeting Message
                        </label>
                        <input
                            type="text"
                            value={messages.welcome_greeting || 'Hi There, How can I help you today?'}
                            onChange={(e) => handleMessageChange('welcome_greeting', e.target.value)}
                            className="w-full px-3 py-2 border border-surface-200 dark:border-surface-600 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500 dark:focus:ring-primary-400/30 dark:focus:border-primary-400 bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100 placeholder:text-surface-400 dark:placeholder:text-surface-500"
                            placeholder="Hi There, How can I help you today?"
                        />
                        <p className="text-xs text-surface-500 dark:text-surface-400 mt-1">Displayed as the main welcome message</p>
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-2">
                            Welcome Subtitle
                        </label>
                        <input
                            type="text"
                            value={messages.welcome_subtitle || 'How can we help you today?'}
                            onChange={(e) => handleMessageChange('welcome_subtitle', e.target.value)}
                            className="w-full px-3 py-2 border border-surface-200 dark:border-surface-600 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500 dark:focus:ring-primary-400/30 dark:focus:border-primary-400 bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100 placeholder:text-surface-400 dark:placeholder:text-surface-500"
                            placeholder="How can we help you today?"
                        />
                        <p className="text-xs text-surface-500 dark:text-surface-400 mt-1">Secondary text under the greeting</p>
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-3">
                            Quick Action Buttons
                        </label>
                        <div className="space-y-2">
                            {suggestions.map((suggestion, index) => (
                                <div key={index} className="flex gap-2">
                                    <input
                                        type="text"
                                        value={suggestion}
                                        onChange={(e) => handleSuggestionChange(index, e.target.value)}
                                        placeholder={`Suggestion ${index + 1}`}
                                        className="flex-1 px-3 py-2 border border-surface-200 dark:border-surface-600 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500 dark:focus:ring-primary-400/30 dark:focus:border-primary-400 bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100 placeholder:text-surface-400 dark:placeholder:text-surface-500"
                                    />
                                    <button
                                        onClick={() => removeSuggestion(index)}
                                        className="px-3 py-2 bg-rose-50 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400 rounded-md hover:bg-rose-100 dark:hover:bg-rose-500/20 transition-colors"
                                    >
                                        Remove
                                    </button>
                                </div>
                            ))}
                        </div>
                        <button
                            onClick={addSuggestion}
                            className="mt-3 px-3 py-2 bg-primary-50 dark:bg-primary-500/10 text-primary-600 dark:text-primary-400 rounded-md hover:bg-primary-100 dark:hover:bg-primary-500/20 transition-colors text-sm font-medium"
                        >
                            + Add Suggestion
                        </button>
                    </div>
                </div>
            </div>

            {/* Chat Interface Section */}
            <div className="border border-surface-200 dark:border-surface-700 rounded-lg p-6 bg-white dark:bg-surface-900">
                <h3 className="text-lg font-semibold mb-4 text-surface-900 dark:text-surface-100">Chat Interface</h3>

                <div className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-2">
                            Message Input Placeholder
                        </label>
                        <input
                            type="text"
                            value={messages.input_placeholder || 'Write a message...'}
                            onChange={(e) => handleMessageChange('input_placeholder', e.target.value)}
                            className="w-full px-3 py-2 border border-surface-200 dark:border-surface-600 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500 dark:focus:ring-primary-400/30 dark:focus:border-primary-400 bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100 placeholder:text-surface-400 dark:placeholder:text-surface-500"
                            placeholder="Write a message..."
                        />
                        <p className="text-xs text-surface-500 dark:text-surface-400 mt-1">Hint text in the chat input field</p>
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-2">
                            Live Chat Button Label
                        </label>
                        <input
                            type="text"
                            value={messages.live_chat_label || 'Live chat'}
                            onChange={(e) => handleMessageChange('live_chat_label', e.target.value)}
                            className="w-full px-3 py-2 border border-surface-200 dark:border-surface-600 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500 dark:focus:ring-primary-400/30 dark:focus:border-primary-400 bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100 placeholder:text-surface-400 dark:placeholder:text-surface-500"
                            placeholder="Live chat"
                        />
                        <p className="text-xs text-surface-500 dark:text-surface-400 mt-1">Label for the live chat action button</p>
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-2">
                            Greeting Bubble Message
                        </label>
                        <input
                            type="text"
                            value={messages.greeting_message || 'Hi! Let us know if you have any questions.'}
                            onChange={(e) => handleMessageChange('greeting_message', e.target.value)}
                            className="w-full px-3 py-2 border border-surface-200 dark:border-surface-600 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500 dark:focus:ring-primary-400/30 dark:focus:border-primary-400 bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100 placeholder:text-surface-400 dark:placeholder:text-surface-500"
                            placeholder="Hi! Let us know if you have any questions."
                        />
                        <p className="text-xs text-surface-500 dark:text-surface-400 mt-1">Initial greeting bubble message (appears after delay)</p>
                    </div>
                </div>
            </div>

            {/* Offline Mode Section */}
            <div className="border border-surface-200 dark:border-surface-700 rounded-lg p-6 bg-white dark:bg-surface-900">
                <h3 className="text-lg font-semibold mb-4 text-surface-900 dark:text-surface-100">Offline Mode</h3>

                <div className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-2">
                            Offline Message
                        </label>
                        <input
                            type="text"
                            value={messages.offline_message || 'Team is currently unavailable'}
                            onChange={(e) => handleMessageChange('offline_message', e.target.value)}
                            className="w-full px-3 py-2 border border-surface-200 dark:border-surface-600 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500 dark:focus:ring-primary-400/30 dark:focus:border-primary-400 bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100 placeholder:text-surface-400 dark:placeholder:text-surface-500"
                            placeholder="Team is currently unavailable"
                        />
                        <p className="text-xs text-surface-500 dark:text-surface-400 mt-1">Header message when bot is offline</p>
                    </div>
                </div>
            </div>

            {/* Post-Chat Section */}
            <div className="border border-surface-200 dark:border-surface-700 rounded-lg p-6 bg-white dark:bg-surface-900">
                <h3 className="text-lg font-semibold mb-4 text-surface-900 dark:text-surface-100">Post-Chat</h3>

                <div className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-2">
                            Rating Prompt
                        </label>
                        <input
                            type="text"
                            value={messages.rating_prompt || 'How was your experience?'}
                            onChange={(e) => handleMessageChange('rating_prompt', e.target.value)}
                            className="w-full px-3 py-2 border border-surface-200 dark:border-surface-600 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500 dark:focus:ring-primary-400/30 dark:focus:border-primary-400 bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100 placeholder:text-surface-400 dark:placeholder:text-surface-500"
                            placeholder="How was your experience?"
                        />
                        <p className="text-xs text-surface-500 dark:text-surface-400 mt-1">Prompt shown in the post-chat rating card</p>
                    </div>

                    <div>
                        <label className="block text-sm font-medium text-surface-700 dark:text-surface-300 mb-2">
                            End Chat Button Label
                        </label>
                        <input
                            type="text"
                            value={messages.end_chat_label || 'End chat and return to AI'}
                            onChange={(e) => handleMessageChange('end_chat_label', e.target.value)}
                            className="w-full px-3 py-2 border border-surface-200 dark:border-surface-600 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500 dark:focus:ring-primary-400/30 dark:focus:border-primary-400 bg-white dark:bg-surface-800 text-surface-900 dark:text-surface-100 placeholder:text-surface-400 dark:placeholder:text-surface-500"
                            placeholder="End chat and return to AI"
                        />
                        <p className="text-xs text-surface-500 dark:text-surface-400 mt-1">Label for ending live chat</p>
                    </div>
                </div>
            </div>

            <div className="bg-sky-50 dark:bg-sky-500/10 border border-sky-200 dark:border-sky-500/20 rounded-lg p-4">
                <p className="text-sm text-sky-800 dark:text-sky-300">
                    💡 <strong>Tip:</strong> Click <strong>Save Configuration</strong> to apply your changes. They will appear in the widget after the next page refresh.
                </p>
            </div>
        </div>
    );
};

export default MessagesTab;
