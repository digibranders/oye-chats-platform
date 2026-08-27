import React from 'react';
import { MessageCircle, CalendarClock } from 'lucide-react';
import { sanitizeColor } from '../services/sanitize';
import { t } from '../i18n/i18n.js';

/**
 * QualifiedLeadCard. Warm-lead conversion prompt rendered inline in the chat
 * thread, right after the bot's answer.
 *
 * Surfaces once a visitor becomes qualified (2+ BANT dimensions marked) AND the
 * bot has meeting booking configured. Rather than a plain-text "connect with our
 * team?" follow-up, the visitor gets an explicit choice (talk to the team now
 * (live-chat handoff) or book a meeting) styled as the same pill chips used for
 * the welcome suggestions, with "Continue with AI" as a low-friction text escape
 * hatch. While it's shown the composer is hidden, so the choice is the visitor's
 * sole next action until they pick one.
 *
 *   Want to talk to our team?
 *   [ 💬 Live chat ]  [ 📅 Book a meeting ]
 *   Continue with AI
 *
 * Props:
 *   - liveChatEnabled : show the "Live chat" chip
 *   - hasMeeting      : show the "Book a meeting" chip
 *   - onConnectSupport: () => void. Visitor chooses live-chat handoff
 *   - onBookMeeting   : () => void. Visitor chooses to book a meeting
 *   - onDismiss       : () => void. Visitor continues with AI
 *   - primaryColor    : brand accent, used to tint the chip icons
 */
const QualifiedLeadCard = ({
    liveChatEnabled = true,
    hasMeeting = true,
    onConnectSupport,
    onBookMeeting,
    onDismiss,
    primaryColor: rawPrimary,
}) => {
    const primaryColor = sanitizeColor(rawPrimary, '#3A0CA3');

    // With neither action available there is nothing to offer, never render an
    // empty prompt (defensive: the backend only emits this card when meeting
    // booking is configured, so ``hasMeeting`` is effectively always true).
    if (!liveChatEnabled && !hasMeeting) return null;

    // Same chip treatment as the welcome suggestions (WelcomeScreen.jsx) so the
    // card reads as a native part of the conversation, not a foreign widget.
    const chipClass =
        'inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-[13px] text-gray-600 ' +
        'bg-gray-50 border border-gray-200 hover:border-blue-300 hover:bg-blue-50 hover:text-blue-700 ' +
        'transition-colors cursor-pointer active:scale-[0.98]';

    return (
        <div
            // Negative top margin pulls the card up out of the messages area's
            // inter-message gap (gap-5/gap-6) so it reads as a natural
            // continuation of the answer above, not a detached card floating a
            // full message-gap below it.
            className="mx-3 -mt-3 flex flex-col gap-2.5"
            style={{ animation: 'fadeUp 0.3s ease-out' }}
            role="group"
            aria-label={t('message.connect_team_aria') || 'Connect with our team'}
        >
            <p className="px-0.5 text-[12px] leading-snug text-gray-500">
                {t('message.want_to_talk') || 'Want to talk to our team?'}
            </p>

            <div className="flex flex-wrap gap-2">
                {liveChatEnabled && (
                    <button type="button" onClick={onConnectSupport} className={chipClass}>
                        <MessageCircle className="w-3.5 h-3.5" style={{ color: primaryColor }} />
                        {t('input.live_chat_aria') || 'Live chat'}
                    </button>
                )}
                {hasMeeting && (
                    <button type="button" onClick={onBookMeeting} className={chipClass}>
                        <CalendarClock className="w-3.5 h-3.5" style={{ color: primaryColor }} />
                        {t('input.book_meeting') || 'Book a meeting'}
                    </button>
                )}
            </div>

            <button
                type="button"
                onClick={onDismiss}
                className="self-start px-0.5 text-[12px] font-medium text-gray-400 hover:text-gray-600 transition-colors"
            >
                {t('message.continue_with_ai') || 'Continue with AI'}
            </button>
        </div>
    );
};

export default QualifiedLeadCard;
