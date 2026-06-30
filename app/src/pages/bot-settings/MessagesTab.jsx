import React from 'react';
import { Sparkles, MessageSquare, MoonStar, Star, Wrench, AlignHorizontalDistributeCenter, AlignVerticalDistributeCenter } from 'lucide-react';

const DEFAULT_SUGGESTIONS = ['Our Services', 'About us', 'Contact us'];

const SECTION_HEADER_BASE = "text-[15px] font-bold text-surface-900 dark:text-surface-50 flex items-center gap-2";
const SECTION_SUBTITLE = "text-[13px] text-surface-500 dark:text-surface-400 mt-0.5";
const CARD = "bg-white dark:bg-surface-900 p-5 rounded-2xl border border-surface-200 dark:border-surface-700 shadow-sm space-y-4";
const FIELD_LABEL = "text-[13px] font-bold text-surface-700 dark:text-surface-300";
const FIELD_INPUT = "w-full h-10 px-3 text-sm text-surface-600 dark:text-surface-300 bg-white dark:bg-surface-900 border border-surface-200 dark:border-surface-700 rounded-lg focus:outline-none focus:border-primary-400 dark:placeholder:text-surface-500";
const FIELD_HELP = "text-[11px] text-surface-400";

/**
 * MessagesTab — visitor-facing copy.
 *
 * Standardized to the shell ↔ tab contract: reads `widget_messages` and
 * `services` from `draft` and writes them back via `set(field, value)`. The
 * `handleMessageChange` / `handleServiceChange` helpers preserve the original
 * per-field merge behaviour.
 *
 * @param {{ draft: object, set: (field: string, value: unknown) => void }} props
 */
const MessagesTab = ({ draft, set }) => {
    const messages = draft?.widget_messages || {};
    // ``services`` is now ``[{name, url}]`` per service. Tolerate stale legacy
    // string entries by coercing them to objects on render — keeps the UI
    // working if the parent hasn't yet been updated to the new shape.
    const services = (Array.isArray(draft?.services) ? draft.services : []).map((s) =>
        typeof s === 'string' ? { name: s, url: '' } : { name: s?.name || '', url: s?.url || '' }
    );

    const suggestions =
        Array.isArray(messages.welcome_suggestions) && messages.welcome_suggestions.length > 0
            ? messages.welcome_suggestions
            : DEFAULT_SUGGESTIONS;

    const handleMessageChange = (key, value) => {
        set('widget_messages', {
            ...messages,
            [key]: value,
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

    // Per-service updates: ``field`` is either ``"name"`` or ``"url"``.
    // Save is debounced at the parent (Save Configuration button), so each
    // keystroke just updates local state via onSettingsChange.
    const handleServiceChange = (index, field, value) => {
        const next = services.map((s, i) => (i === index ? { ...s, [field]: value } : s));
        set('services', next);
    };

    const addService = () => {
        set('services', [...services, { name: '', url: '' }]);
    };

    const removeService = (index) => {
        set('services', services.filter((_, i) => i !== index));
    };

    return (
        <div className="space-y-6 animate-fade-in">
            {/* Services — admin-defined list with per-service link */}
            <div>
                <h3 className={SECTION_HEADER_BASE}>
                    <Wrench className="w-4 h-4 text-primary-500" />
                    Services
                </h3>
                <p className={SECTION_SUBTITLE}>
                    List the services your bot is allowed to answer about. Each service can have its own page link; the bot renders a small ↗ icon next to the service name when it mentions it in an answer.
                </p>
            </div>
            <div className={CARD}>
                <div className="space-y-2">
                    <label className={FIELD_LABEL}>Services Offered</label>
                    <div className="space-y-2">
                        {services.length === 0 && (
                            <p className="text-[12px] text-surface-400 italic">
                                No services listed yet — the bot will answer about anything in your knowledge base. Add one or more services to scope its answers.
                            </p>
                        )}
                        {services.map((service, index) => (
                            <div
                                key={index}
                                className="flex flex-col sm:flex-row gap-2 p-2 rounded-lg bg-surface-50 dark:bg-surface-800/40 border border-surface-200/60 dark:border-surface-700/60"
                            >
                                <input
                                    type="text"
                                    value={service.name}
                                    onChange={(e) => handleServiceChange(index, 'name', e.target.value)}
                                    placeholder={`Service ${index + 1} name (e.g. SEO Audit)`}
                                    className={`flex-1 ${FIELD_INPUT}`}
                                />
                                <input
                                    type="url"
                                    value={service.url}
                                    onChange={(e) => handleServiceChange(index, 'url', e.target.value)}
                                    placeholder="https://example.com/services/seo (optional)"
                                    className={`flex-1 ${FIELD_INPUT}`}
                                />
                                <button
                                    type="button"
                                    onClick={() => removeService(index)}
                                    className="px-3 h-10 bg-rose-50 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400 rounded-lg hover:bg-rose-100 dark:hover:bg-rose-500/20 transition-colors text-sm font-medium shrink-0"
                                >
                                    Remove
                                </button>
                            </div>
                        ))}
                    </div>
                    <button
                        type="button"
                        onClick={addService}
                        className="mt-2 px-3 h-10 bg-primary-50 dark:bg-primary-500/10 text-primary-600 dark:text-primary-400 rounded-lg hover:bg-primary-100 dark:hover:bg-primary-500/20 transition-colors text-sm font-medium"
                    >
                        + Add Service
                    </button>
                    <p className={FIELD_HELP}>
                        The bot refuses any question outside this list once you save at least one entry. Service URLs are optional — services without a URL render as plain text in the bot&apos;s reply.
                    </p>
                </div>
            </div>

            {/* Welcome Screen */}
            <div className="border-t border-surface-200 dark:border-surface-700 pt-6">
                <h3 className={SECTION_HEADER_BASE}>
                    <Sparkles className="w-4 h-4 text-primary-500" />
                    Welcome Screen
                </h3>
                <p className={SECTION_SUBTITLE}>
                    Customize the greeting and quick actions visitors see when the chat opens.
                </p>
            </div>
            <div className={CARD}>
                <div className="space-y-2">
                    <label className={FIELD_LABEL}>Greeting Message</label>
                    <input
                        type="text"
                        value={messages.welcome_greeting || 'Hi There, How can I help you today?'}
                        onChange={(e) => handleMessageChange('welcome_greeting', e.target.value)}
                        className={FIELD_INPUT}
                        placeholder="Hi There, How can I help you today?"
                    />
                    <p className={FIELD_HELP}>Displayed as the main welcome message.</p>
                </div>

                <div className="space-y-2">
                    <label className={FIELD_LABEL}>Welcome Subtitle</label>
                    <input
                        type="text"
                        value={messages.welcome_subtitle || 'How can we help you today?'}
                        onChange={(e) => handleMessageChange('welcome_subtitle', e.target.value)}
                        className={FIELD_INPUT}
                        placeholder="How can we help you today?"
                    />
                    <p className={FIELD_HELP}>Secondary text under the greeting.</p>
                </div>

                <div className="space-y-2">
                    <div className="flex items-center justify-between gap-3">
                        <label className={FIELD_LABEL}>Quick Action Buttons</label>
                        {/* Layout toggle — horizontal (pill row) vs vertical (stacked).
                            Changes reflect live in the widget preview the moment the
                            customer clicks, then persist when they save. */}
                        <div className="inline-flex rounded-lg border border-surface-200 dark:border-surface-700 overflow-hidden">
                            {[
                                { id: 'horizontal', label: 'Horizontal', icon: AlignHorizontalDistributeCenter },
                                { id: 'vertical',   label: 'Vertical',   icon: AlignVerticalDistributeCenter   },
                            ].map((option) => {
                                const LayoutIcon = option.icon;
                                const current = messages.welcome_suggestions_layout || 'horizontal';
                                const active = current === option.id;
                                return (
                                    <button
                                        key={option.id}
                                        type="button"
                                        aria-pressed={active}
                                        aria-label={`${option.label} layout`}
                                        title={`${option.label} layout`}
                                        onClick={() => handleMessageChange('welcome_suggestions_layout', option.id)}
                                        className={`flex items-center gap-1.5 px-2.5 h-8 text-[12px] font-medium transition-colors cursor-pointer ${
                                            active
                                                ? 'bg-primary-500 text-white'
                                                : 'bg-white dark:bg-surface-900 text-surface-600 dark:text-surface-300 hover:bg-surface-50 dark:hover:bg-surface-800'
                                        }`}
                                    >
                                        <LayoutIcon className="w-3.5 h-3.5" />
                                        {option.label}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                    <div className="space-y-2">
                        {suggestions.map((suggestion, index) => (
                            <div key={index} className="flex gap-2">
                                <input
                                    type="text"
                                    value={suggestion}
                                    onChange={(e) => handleSuggestionChange(index, e.target.value)}
                                    placeholder={`Suggestion ${index + 1}`}
                                    className={`flex-1 ${FIELD_INPUT}`}
                                />
                                <button
                                    type="button"
                                    onClick={() => removeSuggestion(index)}
                                    className="px-3 h-10 bg-rose-50 dark:bg-rose-500/10 text-rose-600 dark:text-rose-400 rounded-lg hover:bg-rose-100 dark:hover:bg-rose-500/20 transition-colors text-sm font-medium"
                                >
                                    Remove
                                </button>
                            </div>
                        ))}
                    </div>
                    <button
                        type="button"
                        onClick={addSuggestion}
                        className="mt-2 px-3 h-10 bg-primary-50 dark:bg-primary-500/10 text-primary-600 dark:text-primary-400 rounded-lg hover:bg-primary-100 dark:hover:bg-primary-500/20 transition-colors text-sm font-medium"
                    >
                        + Add Suggestion
                    </button>
                </div>
            </div>

            {/* Chat Interface */}
            <div className="border-t border-surface-200 dark:border-surface-700 pt-6">
                <h3 className={SECTION_HEADER_BASE}>
                    <MessageSquare className="w-4 h-4 text-primary-500" />
                    Chat Interface
                </h3>
                <p className={SECTION_SUBTITLE}>
                    Labels and placeholders shown during the conversation.
                </p>
            </div>
            <div className={CARD}>
                <div className="space-y-2">
                    <label className={FIELD_LABEL}>Message Input Placeholder</label>
                    <input
                        type="text"
                        value={messages.input_placeholder || 'Write a message...'}
                        onChange={(e) => handleMessageChange('input_placeholder', e.target.value)}
                        className={FIELD_INPUT}
                        placeholder="Write a message..."
                    />
                    <p className={FIELD_HELP}>Hint text in the chat input field.</p>
                </div>

                <div className="space-y-2">
                    <label className={FIELD_LABEL}>Live Chat Button Label</label>
                    <input
                        type="text"
                        value={messages.live_chat_label || 'Live chat'}
                        onChange={(e) => handleMessageChange('live_chat_label', e.target.value)}
                        className={FIELD_INPUT}
                        placeholder="Live chat"
                    />
                    <p className={FIELD_HELP}>Label for the live chat action button.</p>
                </div>

                <div className="space-y-2">
                    <label className={FIELD_LABEL}>Greeting Bubble Message</label>
                    <input
                        type="text"
                        value={messages.greeting_message || 'Hi! Let us know if you have any questions.'}
                        onChange={(e) => handleMessageChange('greeting_message', e.target.value)}
                        className={FIELD_INPUT}
                        placeholder="Hi! Let us know if you have any questions."
                    />
                    <p className={FIELD_HELP}>Initial greeting bubble message (appears after delay).</p>
                </div>
            </div>

            {/* Offline Mode */}
            <div className="border-t border-surface-200 dark:border-surface-700 pt-6">
                <h3 className={SECTION_HEADER_BASE}>
                    <MoonStar className="w-4 h-4 text-primary-500" />
                    Offline Mode
                </h3>
                <p className={SECTION_SUBTITLE}>
                    What visitors see when no operators are available.
                </p>
            </div>
            <div className={CARD}>
                <div className="space-y-2">
                    <label className={FIELD_LABEL}>Offline Message</label>
                    <input
                        type="text"
                        value={messages.offline_message || "We'll be right back! Leave a message and we'll follow up shortly."}
                        onChange={(e) => handleMessageChange('offline_message', e.target.value)}
                        className={FIELD_INPUT}
                        placeholder="We'll be right back! Leave a message and we'll follow up shortly."
                    />
                    <p className={FIELD_HELP}>Shown when no operators are online. Keep it warm and action-oriented.</p>
                </div>
            </div>

            {/* Post-Chat */}
            <div className="border-t border-surface-200 dark:border-surface-700 pt-6">
                <h3 className={SECTION_HEADER_BASE}>
                    <Star className="w-4 h-4 text-primary-500" />
                    Post-Chat
                </h3>
                <p className={SECTION_SUBTITLE}>
                    The wrap-up screen shown after a conversation ends.
                </p>
            </div>
            <div className={CARD}>
                <div className="space-y-2">
                    <label className={FIELD_LABEL}>Rating Prompt</label>
                    <input
                        type="text"
                        value={messages.rating_prompt || 'How was your experience?'}
                        onChange={(e) => handleMessageChange('rating_prompt', e.target.value)}
                        className={FIELD_INPUT}
                        placeholder="How was your experience?"
                    />
                    <p className={FIELD_HELP}>Prompt shown in the post-chat rating card.</p>
                </div>

                <div className="space-y-2">
                    <label className={FIELD_LABEL}>End Chat Button Label</label>
                    <input
                        type="text"
                        value={messages.end_chat_label || 'End chat and return to AI'}
                        onChange={(e) => handleMessageChange('end_chat_label', e.target.value)}
                        className={FIELD_INPUT}
                        placeholder="End chat and return to AI"
                    />
                    <p className={FIELD_HELP}>Label for ending live chat.</p>
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
