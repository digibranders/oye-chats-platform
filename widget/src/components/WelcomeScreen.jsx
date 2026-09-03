import React from 'react';
import { t } from '../i18n/i18n.js';
import { SEEDED, authoredCopy, authoredList } from '../i18n/seededCopy.js';
import { stripEmoji } from '../lib/stripEmoji.js';

const WelcomeScreen = ({ settings, onSend, welcomeExiting = false, exitDuration = 350 }) => {
    const messages = settings?.widget_messages || {};
    const defaultSuggestions = [
        t('welcome.suggestion_services') || 'Our Services',
        t('welcome.suggestion_about') || 'About us',
        t('welcome.suggestion_contact') || 'Contact us',
    ];
    // `welcome_suggestions` arrives populated on every bot (backend server_default),
    // so a plain `||` never reached defaultSuggestions and the chips stayed English.
    const configuredSuggestions =
        authoredList(messages.welcome_suggestions, SEEDED.welcome_suggestions) ??
        authoredList(settings?.welcome_suggestions, SEEDED.welcome_suggestions);
    const suggestions = configuredSuggestions || defaultSuggestions;
    // 'horizontal' (default) → pill row that wraps. 'vertical' → full-width
    // stacked rows that read like a menu. The greeting sits just above the
    // first action in both modes; vertical tightens that gap so the welcome
    // reads as the header of a stacked card.
    const layout = messages.welcome_suggestions_layout === 'vertical' ? 'vertical' : 'horizontal';
    const isVertical = layout === 'vertical';

    const getGreeting = () => {
        const hour = new Date().getHours();
        if (hour < 12) return t('welcome.good_morning') || 'Good morning';
        if (hour < 18) return t('welcome.good_afternoon') || 'Good afternoon';
        return t('welcome.good_evening') || 'Good evening';
    };

    // Three distinct cases, and they are not interchangeable:
    //   authored   -> the customer's wording, verbatim, in every language
    //   seeded     -> the backend's default wording, translated
    //   absent     -> the widget's own fallback (a time-of-day greeting)
    // Collapsing the middle case into the first is what froze this screen in
    // English; collapsing it into the last would silently swap a bot's
    // "Hi there" for "Good evening". See i18n/seededCopy.js.
    const hasTitle = Boolean(settings?.welcome_title?.trim());
    const title =
        authoredCopy(settings?.welcome_title, SEEDED.welcome_title)
        || (hasTitle ? t('presets.welcome_title') || SEEDED.welcome_title : getGreeting());

    const hasSubtitle = Boolean(settings?.welcome_subtitle?.trim());
    const subtitle =
        authoredCopy(settings?.welcome_subtitle, SEEDED.welcome_subtitle)
        || (hasSubtitle
            ? t('presets.welcome_subtitle') || SEEDED.welcome_subtitle
            : t('welcome.subtitle') || 'How can I help you today?');

    const contentExitStyle = welcomeExiting ? {
        opacity: 0,
        transform: 'translateY(-20px)',
        transition: `opacity ${exitDuration}ms ease-out, transform ${exitDuration}ms ease-out`,
    } : undefined;

    return (
        <div
            // `text-start`, not `text-left`: the greeting should hug whichever
            // edge the panel starts at, and in Arabic that is the right.
            className="flex flex-col items-start text-start w-full"
            style={contentExitStyle || { animation: 'fadeUp 0.4s ease-out' }}
        >
            {/* `dir="auto"` on both: the customer authors this copy and we do
                not know its language. Without it an English greeting inside an
                RTL panel renders as "!Hi there", because the trailing
                punctuation takes the paragraph's direction rather than the
                run's. */}
            <h2 dir="auto" className="text-2xl font-bold text-[#16202C]">{stripEmoji(title)}</h2>
            <p dir="auto" className={`text-[15px] text-gray-500 ${isVertical ? 'mt-1 mb-3' : 'mt-1'}`}>
                {subtitle}
            </p>

            <div
                className={
                    isVertical
                        ? 'flex flex-col gap-2 mt-2 w-full items-stretch'
                        : 'flex flex-wrap gap-2 mt-5 justify-start'
                }
            >
                {suggestions.map((s, i) => (
                    <button
                        key={s}
                        onClick={() => onSend(null, s)}
                        className={
                            isVertical
                                ? 'w-full text-left px-4 py-2.5 rounded-xl text-[13px] text-gray-700 bg-gray-50 border border-gray-200 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 transition-colors cursor-pointer'
                                : 'px-4 py-2 rounded-full text-[13px] text-gray-600 bg-gray-50 border border-gray-200 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 transition-colors cursor-pointer'
                        }
                        style={welcomeExiting ? undefined : { animation: `fadeUp 0.3s ease-out ${i * 0.08}s both` }}
                    >
                        {s}
                    </button>
                ))}
            </div>

        </div>
    );
};

export default WelcomeScreen;
