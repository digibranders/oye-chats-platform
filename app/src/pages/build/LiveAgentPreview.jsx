import { motion } from 'framer-motion';
import { MessageCircle } from 'lucide-react';
import { useBotContext } from '../../context/BotContext';
import Badge from '../../components/ui/Badge';
import WidgetChatPreview from '../../components/WidgetChatPreview';

const EASE = [0.16, 1, 0.3, 1];

/**
 * Map a bot record (from `useBotContext`) into the settings shape
 * `WidgetChatPreview` expects. Defaults mirror BotSettings' `DEFAULT_DRAFT` so a
 * freshly-created bot missing a field previews exactly as it will in Bot
 * Settings. `previewColor`, when set by the Appearance step, live-recolours the
 * brand (both primary and header, matching the Bot Settings preview payload).
 */
function botToPreviewSettings(bot, previewColor) {
    const primary = previewColor || bot?.primary_color || '#ba68c8';
    return {
        bot_name: bot?.name || 'AI Assistant',
        bot_logo: bot?.bot_logo || null,
        avatar_type: bot?.avatar_type || 'upload',
        orb_color: bot?.orb_color || '',
        primary_color: primary,
        header_color: primary,
        welcome_title: bot?.welcome_title || 'Hi there 👋',
        welcome_subtitle: bot?.welcome_subtitle || 'How can we help you today?',
        waiting_message: bot?.waiting_message || 'Connecting you to support...',
        offline_message: bot?.offline_message || "We'll be right back! Leave a message and we'll follow up shortly.",
        live_chat_enabled: bot?.live_chat_enabled ?? true,
        meeting_booking_enabled: bot?.meeting_booking_enabled ?? false,
        widget_messages: bot?.widget_messages || {},
        feature_flags: bot?.feature_flags || {},
        branding_text: bot?.branding_text || 'Powered by OyeChats',
    };
}

/**
 * A faithful preview of the customer's chat widget that "comes alive" as the
 * agent is built — the emotional core of the guided flow. Before a bot exists it
 * shows a calm empty launcher; once created it renders the shared
 * `WidgetChatPreview` (the exact same mock Bot Settings shows) in the bot's own
 * brand colour, so the Studio preview is pixel-identical to Bot Settings and the
 * real widget. The Appearance step's `previewColor` live-recolours it.
 */
export default function LiveAgentPreview({ previewColor, messages = [], pending = false }) {
    const { selectedBot } = useBotContext();

    return (
        <div className="flex flex-col h-full">
            <div className="flex items-center justify-between mb-3">
                <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--text-secondary)]">Live preview</span>
                {selectedBot ? (
                    <Badge variant="soft" color="default" size="sm">
                        Not live yet
                    </Badge>
                ) : null}
            </div>

            <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, ease: EASE }}
                className="flex justify-center"
            >
                {selectedBot ? (
                    <WidgetChatPreview
                        settings={botToPreviewSettings(selectedBot, previewColor)}
                        state="chat"
                        messages={messages}
                        pending={pending}
                    />
                ) : (
                    // No bot yet (Connect step): show the closed launcher as it would
                    // appear before a visitor opens it.
                    <div className="flex flex-col items-center gap-3 py-16">
                        <div className="w-14 h-14 rounded-full grid place-items-center text-white shadow-lg bg-primary-500">
                            <MessageCircle size={24} />
                        </div>
                        <span className="text-[11px] text-[var(--text-muted)]">Your agent will appear here</span>
                    </div>
                )}
            </motion.div>
        </div>
    );
}
